/**
 * Generic Composio project-API adapter for any toolkit the office admitted on
 * demand. Same custody rules as the Gmail adapter it sits beside: the office
 * project key never leaves this process, no caller chooses the upstream URL,
 * user or account, and every provider payload is projected before it is
 * returned. Ask's Gmail session uses it too (`ManagedConnectors.gmailToolkit`),
 * after `server/composio-gmail.ts` has verified the Gmail config and account;
 * Gmail's saved workflows keep that reviewed read-only reader.
 *
 * API: GET /connected_accounts, POST /connected_accounts/link, GET /tools,
 * POST /tools/execute/{slug}, POST /trigger_instances/{slug}/upsert, PATCH
 * /trigger_instances/manage/{id} — https://docs.composio.dev/reference/api-reference
 */
import { COMPOSIO_PLATFORM_API, type HttpTransport } from './composio-org.ts';
import { classifyAppTool, classifyAppToolCall, APP_TOOL_NAME, type AppToolPolicy } from '../shared/app-tool-policy.ts';

export interface AppBinding {
  apiKey: string; authConfigId: string; userId: string; accountId?: string;
  /** Protected-service check immediately before and after every upstream call. */
  assertAuthority?: () => void;
}
export interface AppAccount { id: string; label?: string; status: string }
export interface AppTool { name: string; description: string; inputSchema: Record<string, unknown>; policy: AppToolPolicy }
export interface ComposioAppAdapter {
  listAccounts(binding: AppBinding, slug: string, signal: AbortSignal): Promise<AppAccount[]>;
  authorize(binding: AppBinding, signal: AbortSignal): Promise<{ url: string; accountId: string; expiresAt: string }>;
  /** Every tool of the toolkit, classified; `blocked` tools are included so the
   * caller can drop them and say why. */
  listTools(binding: AppBinding, slug: string, signal: AbortSignal): Promise<AppTool[]>;
  execute(binding: AppBinding, slug: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** Creates or reuses the trigger instance for `binding.accountId`; returns its `ti_` id. */
  upsertTrigger(binding: AppBinding, slug: string, config: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /** Enables or disables one trigger instance. Only the project key is used. */
  setTriggerStatus(binding: Pick<AppBinding, 'apiKey' | 'assertAuthority'>, triggerId: string, enabled: boolean, signal: AbortSignal): Promise<void>;
}
export const TRIGGER_ID = /^ti_[A-Za-z0-9_-]{1,128}$/;

type ObjectValue = Record<string, any>;
const record = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
class AppAdapterError extends Error { readonly status: number; constructor(message: string, status = 400) { super(`Connected app: ${message}`); this.status = status; } }
const fail = (message: string, status = 400): never => { throw new AppAdapterError(message, status); };

function bindingCopy(input: AppBinding): AppBinding {
  if (!record(input) || typeof input.apiKey !== 'string' || !/^ak_[A-Za-z0-9_-]{5,1000}$/.test(input.apiKey)) fail('the office project key is unusable.', 503);
  if (!identifier(input.authConfigId) || typeof input.userId !== 'string' || !/^[A-Za-z0-9._@:+-]{1,256}$/.test(input.userId) ||
    (input.accountId !== undefined && !identifier(input.accountId))) fail('the saved account binding is invalid.');
  return { apiKey: input.apiKey, authConfigId: input.authConfigId, userId: input.userId, ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.assertAuthority ? { assertAuthority: input.assertAuthority } : {}) };
}

async function readJson(response: Response, limit: number): Promise<ObjectValue> {
  if (!response.body) fail('the provider response was incomplete; no automatic retry was made.', 502);
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '', bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > limit) fail('the provider response exceeded the bounded size.', 502);
      text += decoder.decode(value, { stream: !done });
      if (done) break;
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  let result: unknown;
  try { result = JSON.parse(text); } catch { fail('the provider response was incomplete; no automatic retry was made.', 502); }
  if (!record(result)) fail('the provider response was incomplete; no automatic retry was made.', 502);
  return result as ObjectValue;
}

export type ProjectRest = (binding: Pick<AppBinding, 'apiKey' | 'assertAuthority'>, path: string, signal: AbortSignal,
  init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; limit?: number }) => Promise<Record<string, any>>;
/** One bounded call to the Composio project API under the office project key.
 * The method defaults to GET, or POST with a body. Shared by the app adapter and
 * the webhook subscription client (composio-triggers.ts). */
export function composioProjectRest(options: { fetch?: HttpTransport; base?: string } = {}): ProjectRest {
  const base = (options.base ?? COMPOSIO_PLATFORM_API).replace(/\/+$/, '');
  const transport: HttpTransport = options.fetch ?? ((url, init) => fetch(url, init));
  return async function rest(binding, path, signal, { method, body, limit = 2_000_000 } = {}) {
    try {
      signal.throwIfAborted(); binding.assertAuthority?.();
      const response = await transport(`${base}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error', signal,
        headers: { 'x-api-key': binding.apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected || !response.ok) {
        void response.body?.cancel().catch(() => {});
        // Provider bodies can quote request headers; only a status class is kept.
        if (response.status === 401 || response.status === 403) fail('the office project key or its access was refused.', 403);
        if (response.status === 429) fail('the provider is rate limited. Try again later.', 429);
        if (response.status >= 400 && response.status < 500) fail('the provider refused the request.', 400);
        fail('the provider was unavailable.', 502);
      }
      // A PATCH or DELETE may answer with no content. UNVERIFIED against live Composio.
      const result = response.status === 204 ? {} : await readJson(response, limit);
      binding.assertAuthority?.();
      return result;
    } catch (error) {
      if (error instanceof AppAdapterError) throw error;
      throw new AppAdapterError('the connection was interrupted or its result could not be confirmed. No automatic retry was made.', 502);
    }
  };
}

export function composioAppAdapter(options: { fetch?: HttpTransport; base?: string } = {}): ComposioAppAdapter {
  const rest = composioProjectRest(options);
  function projectAccount(raw: unknown, binding: AppBinding, slug: string): AppAccount {
    const value = raw as ObjectValue;
    if (!record(value) || !identifier(value.id) || value.id.includes(binding.apiKey) || value.toolkit?.slug !== slug || value.auth_config?.id !== binding.authConfigId ||
      (value.user_id !== undefined && value.user_id !== binding.userId) ||
      typeof value.is_disabled !== 'boolean' || typeof value.auth_config.is_disabled !== 'boolean' ||
      typeof value.status !== 'string' || !/^[A-Z_]{1,40}$/.test(value.status)) fail('the provider returned an account outside this private user and auth configuration.', 403);
    const alias = typeof value.alias === 'string' && value.alias.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.alias) && !value.alias.includes(binding.apiKey) ? value.alias : undefined;
    return { id: value.id, ...(alias ? { label: alias } : {}), status: value.is_disabled || value.auth_config.is_disabled ? 'DISABLED' : value.status };
  }
  const cursorOk = (value: unknown, seen: Set<string>) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) && !seen.has(value);
  return {
    async listAccounts(input, slug, signal) {
      const binding = bindingCopy(input);
      const accounts: AppAccount[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ user_ids: binding.userId, auth_config_ids: binding.authConfigId, toolkit_slugs: slug, limit: '50' });
        if (cursor) query.set('cursor', cursor);
        const value = await rest(binding, `/connected_accounts?${query}`, signal);
        if (!Array.isArray(value.items) || value.items.length > 50) fail('account discovery was incomplete.', 502);
        for (const item of value.items) {
          const account = projectAccount(item, binding, slug);
          if (seen.has(account.id) || accounts.length >= 100) fail('account discovery returned duplicate identities or too many accounts.', 502);
          seen.add(account.id); accounts.push(account);
        }
        if (value.next_cursor === undefined || value.next_cursor === null || value.next_cursor === '') return accounts;
        if (!cursorOk(value.next_cursor, cursors)) fail('account pagination was invalid.', 502);
        cursor = value.next_cursor; cursors.add(cursor!);
      }
      return fail('account discovery exceeded its page limit.', 502);
    },
    async authorize(input, signal) {
      const binding = bindingCopy(input);
      // A fixed RealBud completion page; neither callers nor provider data choose the destination.
      const value = await rest(binding, '/connected_accounts/link', signal, { body: { auth_config_id: binding.authConfigId, user_id: binding.userId,
        callback_url: 'https://realbud-managed-gateway.fly.dev/connections/complete' } });
      const url = value.redirect_url;
      let ok = typeof url === 'string' && url.length <= 4096 && !/\s/.test(url) && !url.includes(binding.apiKey);
      if (ok) { try { const parsed = new URL(url); ok = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && (parsed.hostname === 'composio.dev' || parsed.hostname.endsWith('.composio.dev')); } catch { ok = false; } }
      if (!ok || !identifier(value.connected_account_id) || value.connected_account_id.includes(binding.apiKey) ||
        typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now() || Date.parse(value.expires_at) > Date.now() + 86_400_000) fail('the provider did not return a valid, bounded sign-in link.', 502);
      return { url: value.redirect_url, accountId: value.connected_account_id, expiresAt: value.expires_at };
    },
    async listTools(input, slug, signal) {
      const binding = bindingCopy(input);
      const tools: AppTool[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ toolkit_slug: slug, limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const value = await rest(binding, `/tools?${query}`, signal, { limit: 6_000_000 });
        if (!Array.isArray(value.items) || value.items.length > 100) fail('tool discovery was incomplete.', 502);
        for (const item of value.items) {
          if (!record(item) || !APP_TOOL_NAME.test(String(item.slug)) || item.toolkit?.slug !== slug || item.is_deprecated === true || item.no_auth === true) continue;
          const name = item.slug as string;
          if (seen.has(name)) continue; seen.add(name);
          if (tools.length >= 400) fail('the toolkit exposes more tools than this service admits.', 502);
          const schema = record(item.input_parameters) ? item.input_parameters : { type: 'object', properties: {} };
          const annotations = record(item.annotations) ? item.annotations : undefined;
          const description = typeof item.description === 'string' ? item.description.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 1000) : '';
          tools.push({ name, description, inputSchema: structuredClone(schema), policy: classifyAppTool(name, { app: slug, annotations }) });
        }
        if (value.next_cursor === undefined || value.next_cursor === null || value.next_cursor === '') return tools;
        if (!cursorOk(value.next_cursor, cursors)) fail('tool pagination was invalid.', 502);
        cursor = value.next_cursor; cursors.add(cursor!);
      }
      return fail('tool discovery exceeded its page limit.', 502);
    },
    async execute(input, slug, tool, args, signal) {
      const binding = bindingCopy(input);
      if (!binding.accountId) fail('no connected account is bound for this app.', 403);
      if (!record(args)) fail('tool arguments must be an object.');
      // The gateway holds the `blocked` line with the call's own arguments (a
      // calendar patch that cancels, say). Read/review cards are desktop-side:
      // the gateway forwards what the desktop dispatched after its card.
      if (!APP_TOOL_NAME.test(tool) || classifyAppToolCall(tool, args, { app: slug }) === 'blocked') fail('this tool is outside the connected-app boundary.', 403);
      const value = await rest(binding, `/tools/execute/${tool}`, signal, { body: { connected_account_id: binding.accountId, user_id: binding.userId, arguments: args } });
      const failed = value.successful === false || (value.error !== null && value.error !== undefined && value.error !== '');
      const data = value.data === undefined ? {} : value.data;
      const text = JSON.stringify(data);
      if (text.length > 1_500_000) fail('the tool result exceeded the bounded size.', 502);
      // Provider error text can quote request headers or prompt content: a fixed
      // sentence stands in for it, and the projected data is still returned.
      const message = 'The app reported that this operation failed. Nothing was retried; check the app before trying again.';
      return { content: [{ type: 'text', text: failed ? `${message}\n${text}` : text }], ...(failed ? { isError: true } : {}), ...(record(data) ? { structuredContent: data } : {}) };
    },
    async upsertTrigger(input, slug, config, signal) {
      const binding = bindingCopy(input);
      if (!binding.accountId) fail('no connected account is bound for this app.', 403);
      if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(slug) || !record(config)) fail('the trigger is outside the connected-app boundary.', 403);
      const value = await rest(binding, `/trigger_instances/${slug}/upsert`, signal, { body: { connected_account_id: binding.accountId, trigger_config: config } });
      // UNVERIFIED: the response field name; `trigger_id` per Composio's docs, `id` accepted.
      const triggerId = value.trigger_id ?? value.id;
      if (typeof triggerId !== 'string' || !TRIGGER_ID.test(triggerId) || triggerId.includes(binding.apiKey)) fail('the provider did not return a trigger instance id.', 502);
      return triggerId as string;
    },
    async setTriggerStatus(input, triggerId, enabled, signal) {
      if (!record(input) || typeof input.apiKey !== 'string' || !/^ak_[A-Za-z0-9_-]{5,1000}$/.test(input.apiKey)) fail('the office project key is unusable.', 503);
      if (!TRIGGER_ID.test(triggerId)) fail('the trigger instance id is invalid.');
      // UNVERIFIED: body `{status: 'enable' | 'disable'}`.
      await rest(input, `/trigger_instances/manage/${triggerId}`, signal, { method: 'PATCH', body: { status: enabled ? 'enable' : 'disable' } });
    },
  };
}
