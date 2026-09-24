/** Disposable child for managed-mail application QA. Never import in production.
 * Fork with Node 24, --experimental-strip-types and --no-warnings. Only the
 * exact Composio provider fetch boundary is replaced; gateway/parser are real.
 * No credentials or provider keys are logged. Ready credentials travel by IPC.
 */
import { ManagedConnectors, newConnectorCredential, validateConnectorDevices, type ConnectorDevice } from '../../managed-gateway/connectors.ts';
import { createGatewayServer } from '../../managed-gateway/http.ts';
import { fixture } from '../../managed-gateway/testing.ts';

type Agency = 'A' | 'B';
type Mode = 'normal' | 'provider-error' | 'malformed' | 'partial' | 'missing-key';
type JsonObject = Record<string, unknown>;
type Stats = { calls: number; listCalls: number; threadCalls: number; aborted: number; held: number; violations: number };
type AgencyState = {
  credential: string; key: string; device: ConnectorDevice; mode: Mode; stats: Stats;
  threadIds: string[]; armed: boolean; release: (() => void) | null;
};
const BASE = 'https://backend.composio.dev/api/v3.1/';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const TOOL_VERSION = '20260920_00';
const LIST = 'GMAIL_LIST_THREADS', THREAD = 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', PROFILE = 'GMAIL_GET_PROFILE';
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: JsonObject, names: string[]) => Object.keys(value).sort().join(',') === names.sort().join(',');
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const disconnect = () => { if (process.connected) process.disconnect?.(); };
let cleanup: (() => Promise<void>) | undefined;

async function main() {
  const f = fixture();
  const startedAt = Date.now(), messageAt = startedAt - 120_000;
  f.setTime(startedAt);
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b', customerName: 'Fictional Agency B', goLiveEvidence: 'fixture-agency-b' });
  const createAgency = (agency: Agency): AgencyState => {
    const lower = agency.toLowerCase(), credential = newConnectorCredential();
    return {
      credential: credential.token, key: `ak_fictional_gateway_canary_${agency}`, mode: 'normal', armed: false, release: null,
      stats: { calls: 0, listCalls: 0, threadCalls: 0, aborted: 0, held: 0, violations: 0 },
      threadIds: Array.from({ length: 45 }, (_value, index) => (index + (agency === 'A' ? 1 : 0x101)).toString(16)),
      device: { id: `connector-${lower}`, companyId: `company-${lower}`, licenseId: `license-${lower}`,
        memberId: `member-${lower}`, installationId: `installation-${lower}`, profile: 'property', tokenHash: credential.tokenHash,
        active: true, expiresAt: startedAt + 86_400_000, projectKeyEnv: `REALBUD_COMPOSIO_PROJECT_FIXTURE_${agency}`,
        authConfigId: `auth-${lower}`, userId: `user-${lower}`, accountId: `account-${lower}` },
    };
  };
  const agencies: Record<Agency, AgencyState> = { A: createAgency('A'), B: createAgency('B') };
  let violations = 0, stopping = false;
  const originalFetch = globalThis.fetch;
  const providerTasks = new Set<Promise<Response>>();
  const refuse = (agency?: Agency): never => {
    violations++;
    if (agency) agencies[agency].stats.violations++;
    throw new Error('Fixture provider request refused.');
  };
  const account = (state: AgencyState) => ({ id: state.device.accountId, toolkit: { slug: 'gmail' },
    auth_config: { id: state.device.authConfigId, auth_scheme: 'OAUTH2', is_disabled: false },
    user_id: state.device.userId, authScheme: 'OAUTH2', is_disabled: false, status: 'ACTIVE', requested_scopes: [READONLY],
  });
  const tool = (slug: string) => {
    const properties: JsonObject = { user_id: { type: 'string' } };
    if (slug === LIST) Object.assign(properties, { query: { type: 'string' }, max_results: { type: 'integer' }, page_token: { type: 'string' } });
    if (slug === THREAD) properties.thread_id = { type: 'string' };
    return { slug, toolkit: { slug: 'gmail' }, version: TOOL_VERSION, no_auth: false, scopes: [READONLY],
      input_parameters: { type: 'object', properties, required: [] } };
  };
  const thread = (agency: Agency, id: string, mode: Mode) => {
    const state = agencies[agency], index = state.threadIds.indexOf(id) + 1;
    const text = `Fictional agency ${agency} property ${index}: please review this maintenance request.` +
      (index === 1 ? ` Untrusted provider text includes ${state.key}.` : '');
    return { id, messages: [{ id, threadId: id, internalDate: mode === 'malformed' ? 'invalid-date' : String(messageAt), labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [
        { name: 'From', value: `tenant-${index}@agency-${agency.toLowerCase()}.example.test` },
        { name: 'To', value: `staff@agency-${agency.toLowerCase()}.example.test` },
        { name: 'Subject', value: `Agency ${agency} maintenance request ${index}` },
      ], body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') } },
    }] };
  };
  async function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (stopping) throw new Error('Fixture stopping.');
    // Nothing is forwarded to the original fetch, including loopback URLs.
    const headers = new Headers(init?.headers);
    const agency = (['A', 'B'] as const).find(name => headers.get('x-api-key') === agencies[name].key);
    if (!agency) return refuse();
    const state = agencies[agency]; state.stats.calls++;
    let url: URL;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { return refuse(agency); }
    if (!url.href.startsWith(BASE) || url.origin !== 'https://backend.composio.dev' || url.username || url.password || url.hash || init?.redirect !== 'error') return refuse(agency);
    const path = url.pathname.slice('/api/v3.1'.length), method = init.method ?? 'GET';
    const query = url.searchParams;
    let body: unknown;
    if (init.body !== undefined) {
      if (typeof init.body !== 'string' || init.body.length > 32_000) return refuse(agency);
      try { body = JSON.parse(init.body); } catch { return refuse(agency); }
    }
    const noBodyGet = method === 'GET' && body === undefined;
    if (path === `/auth_configs/${state.device.authConfigId}` && noBodyGet && !url.search) {
      return response({ id: state.device.authConfigId, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', status: 'ENABLED', credentials: { scopes: [READONLY] } });
    }
    if (path === '/connected_accounts' && noBodyGet) {
      if (query.get('user_ids') !== state.device.userId || query.get('auth_config_ids') !== state.device.authConfigId ||
        query.get('toolkit_slugs') !== 'gmail' || query.get('account_type') !== 'PRIVATE' || query.get('limit') !== '50' ||
        [...query.keys()].some(key => !['user_ids', 'auth_config_ids', 'toolkit_slugs', 'account_type', 'limit'].includes(key))) return refuse(agency);
      return response({ items: [account(state)] });
    }
    if (path === `/connected_accounts/${state.device.accountId}` && noBodyGet && !url.search) return response(account(state));
    const metadataMatch = /^\/tools\/(GMAIL_GET_PROFILE|GMAIL_LIST_THREADS|GMAIL_FETCH_MESSAGE_BY_THREAD_ID)$/.exec(path);
    if (metadataMatch && noBodyGet && (!url.search || query.size === 1 && query.get('version') === TOOL_VERSION)) return response(tool(metadataMatch[1]));
    const execute = /^\/tools\/execute\/(GMAIL_GET_PROFILE|GMAIL_LIST_THREADS|GMAIL_FETCH_MESSAGE_BY_THREAD_ID)$/.exec(path);
    if (!execute || method !== 'POST' || url.search || !object(body) || !exact(body, ['connected_account_id', 'user_id', 'version', 'arguments']) ||
      body.connected_account_id !== state.device.accountId || body.user_id !== state.device.userId || body.version !== TOOL_VERSION || !object(body.arguments)) return refuse(agency);
    const args = body.arguments;
    if (args.user_id !== 'me') return refuse(agency);
    const slug = execute[1];
    if (slug === PROFILE) {
      if (!exact(args, ['user_id'])) return refuse(agency);
      return response({ successful: true, data: { emailAddress: `staff@agency-${agency.toLowerCase()}.example.test`, messagesTotal: 45, threadsTotal: 45 } });
    }
    if (slug === LIST) {
      if (!exact(args, ['user_id', 'query', 'max_results', ...(args.page_token === undefined ? [] : ['page_token'])]) ||
        typeof args.query !== 'string' || args.query.length > 200 || !/^(?:\{in:inbox(?: in:sent)?\}|in:inbox)? ?after:\d+ before:\d+$/.test(args.query) ||
        !Number.isSafeInteger(args.max_results) || Number(args.max_results) < 1 || Number(args.max_results) > 50) return refuse(agency);
      state.stats.listCalls++;
      const size = Math.min(30, Number(args.max_results));
      const token = args.page_token;
      let offset = 0;
      if (token !== undefined) {
        if (token !== `fictional-${agency}-${size}`) return refuse(agency);
        offset = size;
      }
      const ids = state.threadIds.slice(offset, offset + size), next = offset + ids.length;
      return response({ successful: true, data: { threads: ids.map(id => ({ id })), resultSizeEstimate: state.mode === 'partial' ? 46 : 45,
        ...(next < state.threadIds.length ? { nextPageToken: `fictional-${agency}-${next}` } : {}) } });
    }
    if (!exact(args, ['user_id', 'thread_id']) || typeof args.thread_id !== 'string' || !state.threadIds.includes(args.thread_id)) return refuse(agency);
    state.stats.threadCalls++;
    const mode = state.mode;
    if (state.armed) {
      state.armed = false; state.stats.held++;
      let counted = false;
      const aborted = () => { if (!counted) { counted = true; state.stats.aborted++; } };
      if (init.signal?.aborted) aborted(); else init.signal?.addEventListener('abort', aborted, { once: true });
      try {
        await new Promise<void>(resolve => {
          state.release = resolve;
          process.send?.({ type: 'held', agency });
        });
        // Deliberately return a late success even after the request was aborted.
        // Only the real adapter/gateway authority checks may suppress this result.
      } finally { init.signal?.removeEventListener('abort', aborted); state.release = null; }
    }
    if (mode === 'provider-error') return response({ error: `Fictional upstream failure ${state.key}` }, 503);
    return response({ successful: true, data: thread(agency, args.thread_id, mode) });
  }
  globalThis.fetch = (input, init) => {
    const pending = providerFetch(input, init);
    providerTasks.add(pending);
    void pending.then(() => providerTasks.delete(pending), () => providerTasks.delete(pending));
    return pending;
  };
  const connectors = new ManagedConnectors({ ledger: f.ledger,
    devices: () => {
      f.setTime(Date.now());
      return stopping ? [] : validateConnectorDevices({ version: 1, devices: Object.values(agencies).map(state => state.device) });
    },
    secret: name => {
      const state = Object.values(agencies).find(value => value.device.projectKeyEnv === name);
      return state?.mode === 'missing-key' ? undefined : state?.key;
    },
  });
  const server = createGatewayServer({ gateway: f.gateway(), billing: f.billing, connectors, allowedOrigins: new Set(),
    portal: { async authenticate() { throw new Error('Fixture portal is unavailable.'); } } });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const release = (agency?: Agency) => {
    let released = 0;
    for (const name of agency ? [agency] : ['A', 'B'] as Agency[]) {
      const state = agencies[name]; state.armed = false;
      if (state.release) { state.release(); released++; }
    }
    return released;
  };
  let shutdown: Promise<void> | null = null;
  const stop = () => shutdown ??= (async () => {
    stopping = true; release();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...providerTasks]);
    await closed;
    await new Promise<void>(resolve => setImmediate(resolve));
    globalThis.fetch = originalFetch; f.close();
  })();
  cleanup = stop;
  const ipc = (value: unknown) => new Promise<void>(resolve => {
    if (!process.connected || !process.send) { resolve(); return; }
    process.send(value, () => resolve());
  });
  process.on('message', (message: unknown) => {
    void (async () => {
      const id = object(message) && (Number.isSafeInteger(message.id) || typeof message.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(message.id)) ? message.id : null;
      try {
        if (!object(message) || id === null || typeof message.command !== 'string') throw new Error('Invalid command.');
        const agency = message.agency === 'A' || message.agency === 'B' ? message.agency : undefined;
        let result: unknown;
        if (message.command === 'stats' && exact(message, ['id', 'command'])) {
          result = { agencies: Object.fromEntries((['A', 'B'] as const).map(name => [name, { ...agencies[name].stats, holding: !!agencies[name].release }])), violations };
        } else if (message.command === 'release' && exact(message, ['id', 'command', ...(message.agency === undefined ? [] : ['agency'])]) && (message.agency === undefined || agency)) {
          result = { released: release(agency) };
        } else if (message.command === 'stop' && exact(message, ['id', 'command'])) {
          await stop(); await ipc({ id, result: { stopped: true } }); disconnect(); return;
        } else if (!agency || stopping) throw new Error('Unavailable command.');
        else if (message.command === 'hold' && exact(message, ['id', 'command', 'agency'])) {
          if (agencies[agency].armed || agencies[agency].release) throw new Error('Hold already pending.');
          agencies[agency].armed = true; result = { armed: true };
        } else if (message.command === 'revoke' && exact(message, ['id', 'command', 'agency', 'active']) && typeof message.active === 'boolean') {
          agencies[agency].device = { ...agencies[agency].device, active: message.active }; result = { active: message.active };
        } else if (message.command === 'suspend' && exact(message, ['id', 'command', 'agency', 'active']) && typeof message.active === 'boolean') {
          f.ledger.setService(agencies[agency].device.companyId, message.active, f.tenant.serviceExpiresAt, `fictional-service-${agency}`); result = { active: message.active };
        } else if (message.command === 'mode' && exact(message, ['id', 'command', 'agency', 'value']) && ['normal', 'provider-error', 'malformed', 'partial', 'missing-key'].includes(String(message.value))) {
          agencies[agency].mode = message.value as Mode; result = { mode: agencies[agency].mode };
        } else throw new Error('Unsupported command.');
        await ipc({ id, result });
      } catch { await ipc({ id, error: 'fixture_command_failed' }); }
    })().catch(() => { void stop().finally(() => { process.exitCode = 1; disconnect(); }); });
  });
  process.once('disconnect', () => { void stop(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().finally(() => { process.exitCode = 0; disconnect(); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable.');
  await ipc({ type: 'ready', endpoint: `http://127.0.0.1:${address.port}`, agencies: Object.fromEntries(
    (['A', 'B'] as const).map(name => [name, { credential: agencies[name].credential, accountId: agencies[name].device.accountId }]),
  ) });
}

if (!process.send) process.exitCode = 2;
else void main().catch(async () => {
  await cleanup?.().catch(() => undefined);
  process.exitCode = 1;
  if (process.connected) process.send?.({ type: 'error', error: 'fixture_start_failed' }, disconnect);
});
