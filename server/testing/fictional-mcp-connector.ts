import { createHash } from 'node:crypto';

/** An in-process fictional OAuth + MCP service for connector tests: answers
 * only for `mcpOrigin` and `authOrigin`, throws for any other host. No real
 * network, account or token. Tool replies come from `tools`. */
export function fictionalConnectorService(input: { mcpOrigin: string; authOrigin: string; scopes: string[]; tools: Record<string, (args: Record<string, any>) => unknown> }) {
  const s = {
    requests: [] as string[], registrations: [] as Array<Record<string, unknown>>, tokenCalls: [] as URLSearchParams[], revokes: [] as URLSearchParams[],
    codes: new Map<string, { challenge: string; redirectUri: string; clientId: string }>(), access: new Set<string>(), refresh: new Set<string>(),
    calls: [] as Array<{ name: string; args: Record<string, any> }>,
    grantScope: input.scopes.filter(scope => !scope.endsWith(':write')).slice(0, 2).join(' '), refreshMode: 'ok' as 'ok' | 'invalid_grant', refreshDelay: 0,
    revokeDown: false, mcpDown: false, toolList: [] as Array<Record<string, unknown>>, tokensSeen: [] as string[], metadataPatch: {} as Record<string, unknown>, resourcePatch: {} as Record<string, unknown>, n: 0,
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const issue = () => {
    const access = `fictional-access-secret-${++s.n}`, refresh = `fictional-refresh-secret-${s.n}`;
    s.access.add(access); s.refresh.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: s.grantScope };
  };
  const fetch: typeof globalThis.fetch = async (target, init) => {
    const url = new URL(String(target)); s.requests.push(url.toString());
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.origin === input.mcpOrigin && url.pathname === '/.well-known/oauth-protected-resource') {
      return json(200, { resource: input.mcpOrigin, authorization_servers: [input.authOrigin], scopes_supported: input.scopes, ...s.resourcePatch });
    }
    if (url.origin === input.mcpOrigin && url.pathname.startsWith('/mcp')) {
      if (s.mcpDown) return new Response(null, { status: 502 });
      const token = String((init?.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '');
      if (token) s.tokensSeen.push(token);
      if (!s.access.has(token)) return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${input.mcpOrigin}/.well-known/oauth-protected-resource"` });
      const message = JSON.parse(body);
      if (message.method === 'initialize') return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fictional', version: '0' } } }, { 'mcp-session-id': 'fictional-session' });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: message.id, result: { tools: s.toolList } });
      const { name, arguments: args } = message.params; s.calls.push({ name, args });
      const tool = input.tools[name];
      if (!tool) return json(200, { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [] } });
      return json(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(tool(args)) }], isError: false } });
    }
    if (url.origin === input.authOrigin && url.pathname === '/.well-known/oauth-authorization-server') {
      const a = input.authOrigin;
      return json(200, { issuer: a, authorization_endpoint: `${a}/oauth/authorize`, token_endpoint: `${a}/oauth/token`, registration_endpoint: `${a}/oauth/register`,
        revocation_endpoint: `${a}/oauth/revoke`, authorization_response_iss_parameter_supported: true, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], ...s.metadataPatch });
    }
    if (url.origin === input.authOrigin && url.pathname === '/oauth/register') {
      const value = JSON.parse(body); s.registrations.push(value);
      return json(201, { client_id: `fictional-client-${s.registrations.length}`, redirect_uris: value.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (url.origin === input.authOrigin && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body); s.tokenCalls.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        const code = s.codes.get(form.get('code') ?? ''); s.codes.delete(form.get('code') ?? '');
        if (!code || code.clientId !== form.get('client_id') || code.redirectUri !== form.get('redirect_uri') ||
            createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
      if (s.refreshDelay) await new Promise(resolve => setTimeout(resolve, s.refreshDelay));
      if (s.refreshMode === 'invalid_grant' || !s.refresh.delete(form.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
      return json(200, issue());
    }
    if (url.origin === input.authOrigin && url.pathname === '/oauth/revoke') {
      if (s.revokeDown) throw new TypeError('fictional network: down');
      s.revokes.push(new URLSearchParams(body)); return json(200, {});
    }
    throw new TypeError(`fictional network: unexpected ${url.host}`);
  };
  /** The person's browser approving at the service: returns the callback query. */
  const approve = (authorizeUrl: string, iss = input.authOrigin) => {
    const url = new URL(authorizeUrl), code = `fictional-code-${++s.n}`;
    s.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirectUri: url.searchParams.get('redirect_uri')!, clientId: url.searchParams.get('client_id')! });
    return new URLSearchParams({ code, state: url.searchParams.get('state')!, iss });
  };
  /** Public addresses for the two fictional hosts (TEST-NET would be refused). */
  const resolve = async () => [{ address: '93.184.216.34' }];
  return { s, fetch, approve, resolve };
}
