import { parseHermiosProfile, type HermiosProfile } from '../shared/hermios-modules.ts';
import { readMcpRpcResponse } from './composio.ts';

/** One streamable-HTTP MCP session that reads `get_hermios_profile` with a
 * member's bearer token. Same call shape as `server/hermios-modules.ts`:
 * `{ name, arguments: {} }`, accepted only as `isError: false` with
 * `structuredContent`. Errors carry a code, never provider text or the token. */
export class HermiosMcpError extends Error {
  readonly code: 'unauthorized' | 'unavailable' | 'invalid';
  constructor(code: 'unauthorized' | 'unavailable' | 'invalid') {
    super(code === 'unauthorized' ? 'Hermios refused the connection.' : code === 'invalid' ? 'Hermios returned an unverified profile.' : 'Hermios could not be reached.');
    this.name = 'HermiosMcpError';
    this.code = code;
  }
}

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26']);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function readHermiosProfile(options: {
  fetch: typeof fetch; url: string; accessToken: string; signal: AbortSignal;
}): Promise<HermiosProfile> {
  let session: string | null = null, protocol = PROTOCOL_VERSION;
  const post = async (message: Record<string, unknown>): Promise<Response> => {
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: 'POST', redirect: 'error', signal: options.signal,
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(message.method !== 'initialize' ? { 'mcp-protocol-version': protocol } : {}),
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(message),
      });
    } catch { throw new HermiosMcpError('unavailable'); }
    if (response.status === 401) { await response.body?.cancel().catch(() => {}); throw new HermiosMcpError('unauthorized'); }
    if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => {}); throw new HermiosMcpError('unavailable'); }
    const next = response.headers.get('mcp-session-id');
    if (next && (!/^[\x21-\x7e]{1,512}$/.test(next) || (message.method !== 'initialize' && next !== session))) {
      await response.body?.cancel().catch(() => {});
      throw new HermiosMcpError('invalid');
    }
    if (message.method === 'initialize') session = next;
    return response;
  };
  const rpc = async (id: string, method: string, params: unknown) => {
    const response = await post({ jsonrpc: '2.0', id, method, params });
    try { return await readMcpRpcResponse(response, id, options.signal); }
    catch { throw new HermiosMcpError(options.signal.aborted ? 'unavailable' : 'invalid'); }
  };

  const init = await rpc('initialize', 'initialize', {
    protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'RealBud', version: '1.0.0' },
  });
  if (!SUPPORTED_PROTOCOLS.has(init.protocolVersion) || !record(init.capabilities) || !record(init.capabilities.tools)) throw new HermiosMcpError('invalid');
  protocol = init.protocolVersion;
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await initialized.body?.cancel().catch(() => {});
  const result = await rpc('profile', 'tools/call', { name: 'get_hermios_profile', arguments: {} });
  if (!record(result) || result.isError !== false || !record(result.structuredContent)) throw new HermiosMcpError('invalid');
  try { return parseHermiosProfile(result.structuredContent); }
  catch { throw new HermiosMcpError('invalid'); }
}
