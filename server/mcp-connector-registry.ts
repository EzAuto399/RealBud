import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import {
  classifyConnectorTool, CONNECTOR_ID, connectorAdminRoute, CONNECTORS_API, connectorRoute, CONSEQUENTIAL_WARNING, MAX_TOOL_DESCRIPTION, stripSchemaProse,
  type ConnectorEntryState, type ConnectorEntryView, type ConnectorRegistryView, type ConnectorState, type ConnectorToolClass,
} from '../shared/mcp-connector.ts';
import {
  canonicalJson, ConnectorError, createMcpConnector, logUnexpected, publicServerAddress, scrubCredentials,
  type Approval, type ConnectorCallbackPage, type ConnectorGrant, type McpConnector, type McpConnectorOptions, type RemoteTool, type ToolClass,
} from './mcp-connector-core.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import type { BudMcpConnectors } from './mcp-connector-broker.ts';

/**
 * Custom connectors, per workspace, in private storage under the data
 * directory (never in a worker profile). An owner or admin adds one by server
 * address; its tools are listed, classified (read / write / consequential) and
 * held as `pending_review` with reads proposed on and everything else off.
 * Only after the owner approves are any tools exposed, and only while the
 * listed tools still match the reviewed digest: a new, renamed, re-described
 * or re-shaped tool quarantines the connector. Built-in presets (Redbark) are
 * listed but cannot be removed or re-reviewed here.
 *
 * A custom service's tool names are its own claims, so they never grant
 * authority: every tool starts off; an enabled tool runs through the
 * once-only card with its exact arguments unless the owner marked that
 * read-looking tool trusted; a consequential tool needs the owner's explicit
 * acceptance of CONSEQUENTIAL_WARNING and shows its own card on every call.
 * Drift clears trusted marks and consequential enables.
 */

interface StoredTool { name: string; toolClass: ConnectorToolClass; description: string; inputSchema: Record<string, unknown> }
interface Proposal { digest: string; tools: StoredTool[]; oversized?: boolean }
interface StoredEntry {
  id: string; label: string; serverUrl: string; auth: 'oauth' | 'header'; scopes: string[];
  /** Reviewed tools Bud may call, by how they run: 'read' = trusted, no card;
   * 'write' = once-only card; 'consequential' = consequential card. Exposed only while active. */
  allowlist: Record<string, ToolClass>;
  /** Who enabled each consequential tool, and when (after accepting the warning). */
  consequentialEnabled?: Record<string, { by: string; at: string }>;
  /** Digest of the reviewed tool list; null until first approval. */
  toolsDigest: string | null;
  proposal: Proposal | null;
  state: ConnectorEntryState;
  reviewedBy: string | null; reviewedAt: string | null; addedBy: string; addedAt: string;
  /** Tombstone written before credentials are purged; the entry is gone once removal finishes. */
  removing?: boolean;
}
interface StoredRegistry { version: 1; workspaceId: string; connectors: StoredEntry[] }

export interface BuiltInConnector { connector: McpConnector; label: string; serverUrl: string; tools: Readonly<Record<string, ToolClass>> }
export interface AskConnectorTool { connector: string; label: string; tool: string; toolClass: ToolClass; description: string; inputSchema: Record<string, unknown> }
export interface RegistryReply { kind: 'json'; status: number; body: unknown }
export interface RegistryPage { kind: 'page'; page: ConnectorCallbackPage }

/** Storage limits: per-tool schema after prose is removed, the whole registry
 * well under private-json's 2 MB admission for an existing file, which is
 * also the read cap. */
const MAX_CONNECTORS = 20, MAX_SCHEMA = 4_000, MAX_FILE = 2_000_000, REGISTRY_BUDGET = 1_500_000, MAX_ASK_TOOLS = 100;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/g;
const plain = (value: string, max: number) => value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The complete raw listing of every tool (each tool's `rawHash`, taken before
 * truncation or redaction). A listing with any tool over the raw cap has no
 * digest: it is quarantined instead (see `observe`). */
export function toolsDigest(tools: readonly RemoteTool[]): string | null {
  if (tools.some(tool => tool.rawHash === null)) return null;
  const rows = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({ name: tool.name, rawHash: tool.rawHash }));
  return createHash('sha256').update(canonicalJson(rows)).digest('hex');
}
export function proposalFor(tools: readonly RemoteTool[]): Proposal {
  const stored = tools.map((tool): StoredTool => {
    // Schema prose is removed and credential-shaped text redacted before storage.
    const stripped = scrubCredentials(stripSchemaProse(tool.inputSchema), []) as Record<string, unknown>;
    const schema = JSON.stringify(stripped).length <= MAX_SCHEMA ? stripped : { type: 'object' };
    return { name: tool.name, toolClass: classifyConnectorTool(tool.name, tool.annotations),
      description: plain(scrubCredentials(tool.description, []), MAX_TOOL_DESCRIPTION), inputSchema: schema };
  });
  // Every tool starts off until the owner reviews it. A raw listing over the cap
  // keeps no tools and a digest no review can match; review is refused.
  const digest = toolsDigest(tools);
  return digest ? { digest, tools: stored } : { digest: createHash('sha256').update(`raw-over-cap:${Date.now()}:${Math.random()}`).digest('hex'), tools: [], oversized: true };
}
const NEEDS_ATTENTION = 'RealBud could not read this connection. Remove the connector and add it again.';
const overBudget = () => new ConnectorError('invalid_request', 'This service lists more tool detail than RealBud can keep for review (1.5 MB in all). Ask the provider for a smaller tool set, or remove another connector.', 400);

export function createConnectorRegistry(options: McpConnectorOptions & {
  dataDir: string;
  builtIns?: BuiltInConnector[];
  /** Deadline for the address check when a connector is added (default 10 s). */
  lookupTimeoutMs?: number;
}) {
  const path = join(options.dataDir, 'connectors', 'registry.json');
  const builtIns = new Map((options.builtIns ?? []).map(item => [item.connector.id, item]));
  const instances = new Map<string, McpConnector>();
  /** Removal tombstones: an id being removed gets no new instance, and an
   * instance commits credentials only while its epoch is the id's current one. */
  const removing = new Set<string>();
  const epochs = new Map<string, number>();
  let cache: StoredRegistry | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const now = options.now ?? Date.now;

  const forbidden = () => new ConnectorError('forbidden', 'Only the office owner or an administrator can change connectors.', 403);
  const invalid = (message: string) => new ConnectorError('invalid_request', message, 400);
  const notFound = () => new ConnectorError('not_connected', 'That connector is not set up here.', 404);

  async function load(): Promise<StoredRegistry> {
    const workspaceId = options.workspaceId();
    if (cache && cache.workspaceId === workspaceId) return cache;
    const saved = await readPrivateJson(path, MAX_FILE);
    if (saved === undefined) cache = { version: 1, workspaceId, connectors: [] };
    else if (!object(saved) || saved.version !== 1 || saved.workspaceId !== workspaceId || !Array.isArray(saved.connectors)) throw new Error('Connector settings need recovery.');
    else cache = saved as StoredRegistry;
    return cache;
  }
  /** One registry change at a time; the cache follows the saved file. */
  function mutate<T>(work: (registry: StoredRegistry) => Promise<T> | T): Promise<T> {
    const run = chain.catch(() => {}).then(async () => {
      const registry = structuredClone(await load());
      const result = await work(registry);
      if (Buffer.byteLength(JSON.stringify(registry)) > REGISTRY_BUDGET) throw overBudget();
      await writePrivateJson(path, registry);
      cache = registry;
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }
  const entryOf = (id: string) => cache?.connectors.find(entry => entry.id === id);

  /** Records what the server lists now; drift from the reviewed list quarantines. */
  async function observe(id: string, tools: RemoteTool[]): Promise<void> {
    const proposal = proposalFor(tools);
    let quarantined = false;
    const record = (next: Proposal) => mutate(registry => {
      const entry = registry.connectors.find(row => row.id === id);
      if (!entry) return;
      if (entry.state === 'active' && (next.oversized || next.digest !== entry.toolsDigest)) {
        // Drift: nothing exposed, trusted marks and consequential enables cleared.
        entry.state = 'quarantined';
        entry.allowlist = Object.fromEntries(Object.entries(entry.allowlist).filter(([, toolClass]) => toolClass !== 'consequential').map(([name]) => [name, 'write' as const]));
        entry.consequentialEnabled = {};
        quarantined = true;
      }
      if (entry.state !== 'active' && entry.proposal?.digest !== next.digest) entry.proposal = next;
    });
    try { await record(proposal); }
    catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'invalid_request') throw error;
      // Over budget: keep the digest (so drift still quarantines) but not the tools.
      await record({ digest: proposal.digest, tools: [], oversized: true });
    }
    if (quarantined) instances.get(id)?.abortInFlight();
  }

  function connectorFor(entry: StoredEntry, forRemoval = false): McpConnector {
    if (!forRemoval && (removing.has(entry.id) || entry.removing)) throw notFound();
    const existing = instances.get(entry.id);
    if (existing) return existing;
    const epoch = epochs.get(entry.id) ?? 0;
    const connector = createMcpConnector({
      id: entry.id, label: entry.label, serverUrl: entry.serverUrl, scopes: entry.scopes, auth: entry.auth,
      committable: () => !removing.has(entry.id) && (epochs.get(entry.id) ?? 0) === epoch && entryOf(entry.id)?.removing !== true && entryOf(entry.id) !== undefined,
      allowlist: () => { const current = entryOf(entry.id); return current?.state === 'active' ? current.allowlist : {}; },
      async verify(_call, listTools) {
        const tools = await listTools();
        await observe(entry.id, tools);
        return `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
      },
    }, options);
    instances.set(entry.id, connector);
    return connector;
  }
  async function connector(id: string): Promise<McpConnector | null> {
    const builtIn = builtIns.get(id);
    if (builtIn) return builtIn.connector;
    const entry = (await load()).connectors.find(row => row.id === id);
    return entry && !entry.removing && !removing.has(id) ? connectorFor(entry) : null;
  }

  /** One connector's connection, failing closed: an entry whose state cannot be
   * read shows as needing attention instead of breaking the whole list. */
  async function connectionOf(id: string, read: () => Promise<ConnectorState>, canManage: boolean): Promise<ConnectorState> {
    try { return { ...await read(), canManage }; }
    catch (error) {
      const known = error instanceof ConnectorError;
      if (!known) logUnexpected(`${id} state`, error);
      return { version: 1, connector: id, status: 'unavailable', account: null, generation: 0, reason: known ? error.message : NEEDS_ATTENTION, canManage };
    }
  }

  async function view(canManage: boolean): Promise<ConnectorRegistryView> {
    const registry = await load();
    const connectors: ConnectorEntryView[] = [];
    for (const item of builtIns.values()) {
      connectors.push({ id: item.connector.id, label: item.label, serverUrl: item.serverUrl, auth: 'oauth', builtIn: true, state: 'active', reviewedAt: null, proposalDigest: null, oversized: false,
        tools: Object.entries(item.tools).map(([name, toolClass]) => ({ name, toolClass, description: '', enabled: toolClass === 'read', trusted: toolClass === 'read' })),
        connection: await connectionOf(item.connector.id, () => item.connector.state(), canManage) });
    }
    for (const entry of registry.connectors) {
      if (entry.removing || removing.has(entry.id)) continue;
      const tools = (entry.proposal?.tools ?? []).map(tool => {
        const allowed = Object.hasOwn(entry.allowlist, tool.name) ? entry.allowlist[tool.name] : undefined;
        return { name: tool.name, toolClass: tool.toolClass, description: tool.description, enabled: allowed !== undefined, trusted: allowed === 'read' && tool.toolClass === 'read' };
      });
      connectors.push({ id: entry.id, label: entry.label, serverUrl: entry.serverUrl, auth: entry.auth, builtIn: false, state: entry.state, reviewedAt: entry.reviewedAt,
        proposalDigest: entry.proposal?.digest ?? null, oversized: entry.proposal?.oversized === true, tools, connection: await connectionOf(entry.id, async () => connectorFor(entry).state(), canManage) });
    }
    return { version: 1, canManage, connectors };
  }

  async function add(grant: ConnectorGrant, body: unknown): Promise<ConnectorRegistryView> {
    if (grant.authority !== 'manage') throw forbidden();
    if (!object(body) || Object.keys(body).some(key => !['serverUrl', 'label', 'auth', 'scopes'].includes(key))) throw invalid('Give the server address and a name.');
    const label = typeof body.label === 'string' ? plain(body.label, 60) : '';
    const auth = body.auth === undefined ? 'oauth' : body.auth;
    const scopes = body.scopes === undefined ? [] : body.scopes;
    if (!label || typeof body.serverUrl !== 'string' || body.serverUrl.length > 2048 || (auth !== 'oauth' && auth !== 'header') ||
        !Array.isArray(scopes) || scopes.length > 20 || scopes.some(scope => typeof scope !== 'string' || !/^[\x21-\x7e]{1,100}$/.test(scope))) throw invalid('Give the server address and a name.');
    let url: URL;
    try { url = new URL(body.serverUrl.trim()); } catch { throw invalid('Use the full https:// address of the service.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw invalid('Use the full https:// address of the service, without a port or query.');
    // Public addresses only; every request is pinned again when it is sent.
    await publicServerAddress(url.toString(), options.resolve, AbortSignal.timeout(options.lookupTimeoutMs ?? 10_000)).catch(() => { throw invalid('That address is private, local or could not be found.'); });
    if (!(await grant.stillManages())) throw forbidden();
    await mutate(registry => {
      if (registry.connectors.length >= MAX_CONNECTORS) throw invalid(`At most ${MAX_CONNECTORS} connectors can be added.`);
      if (registry.connectors.some(entry => entry.serverUrl === url.toString())) throw invalid('That service is already added.');
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      const base = /^[a-z][a-z0-9-]+$/.test(slug) ? slug : `c-${slug || 'connector'}`.slice(0, 32);
      const taken = (candidate: string) => !CONNECTOR_ID.test(candidate) || builtIns.has(candidate) || registry.connectors.some(entry => entry.id === candidate);
      let id = base;
      for (let n = 2; taken(id); n++) id = `${base}-${n}`;
      registry.connectors.push({ id, label, serverUrl: url.toString(), auth, scopes: scopes as string[], allowlist: {}, toolsDigest: null, proposal: null,
        state: 'pending_review', reviewedBy: null, reviewedAt: null, addedBy: grant.principal, addedAt: new Date(now()).toISOString() });
    });
    return view(true);
  }

  async function review(grant: ConnectorGrant, id: string, body: unknown): Promise<ConnectorRegistryView> {
    if (grant.authority !== 'manage') throw forbidden();
    if (builtIns.has(id)) throw invalid('Built-in connectors are reviewed by RealBud.');
    const names = (value: unknown) => value === undefined ? [] : Array.isArray(value) && value.length <= 300 && value.every(name => typeof name === 'string') ? value as string[] : null;
    const allowedKeys = ['digest', 'enabled', 'trusted', 'consequential', 'warning'];
    const enabled = object(body) ? names(body.enabled) : null, trusted = object(body) ? names(body.trusted) : null, consequential = object(body) ? names(body.consequential) : null;
    if (!object(body) || Object.keys(body).some(key => !allowedKeys.includes(key)) || typeof body.digest !== 'string' || !enabled || !trusted || !consequential) throw invalid('Review the listed tools again.');
    if (consequential.length && body.warning !== CONSEQUENTIAL_WARNING) throw invalid('Accept the warning before turning on a consequential tool.');
    if (!(await grant.stillManages())) throw forbidden();
    const workspaceId = options.workspaceId();
    await mutate(async registry => {
      // Re-check inside the serialized commit: a revoked owner or another workspace changes nothing.
      if (!(await grant.stillManages().catch(() => false)) || options.workspaceId() !== workspaceId || registry.workspaceId !== workspaceId) throw forbidden();
      const entry = registry.connectors.find(row => row.id === id);
      if (!entry || entry.removing) throw notFound();
      // A stale review (the server listed something else since) is refused.
      if (!entry.proposal || entry.proposal.digest !== body.digest) throw new ConnectorError('stale', 'The service listed different tools since this review. Check it and review again.', 409);
      if (entry.proposal.oversized) throw overBudget();
      const classes = new Map(entry.proposal.tools.map(tool => [tool.name, tool.toolClass]));
      const allowlist: Record<string, ToolClass> = {}, consequentialEnabled: Record<string, { by: string; at: string }> = {};
      const at = new Date(now()).toISOString();
      for (const name of new Set(enabled)) {
        const toolClass = classes.get(name);
        if (!toolClass || toolClass === 'consequential') throw invalid('Turn on consequential tools separately, after the warning.');
        allowlist[name] = 'write';
      }
      for (const name of new Set(trusted)) {
        // A trusted mark only lifts the card from a tool whose name and annotations already read as read-only.
        if (classes.get(name) !== 'read' || allowlist[name] !== 'write') throw invalid('Only turned-on tools that look read-only can be trusted.');
        allowlist[name] = 'read';
      }
      for (const name of new Set(consequential)) {
        if (classes.get(name) !== 'consequential' || Object.hasOwn(allowlist, name)) throw invalid('Only listed consequential tools can be turned on here.');
        allowlist[name] = 'consequential';
        consequentialEnabled[name] = { by: grant.principal, at };
      }
      Object.assign(entry, { allowlist, consequentialEnabled, toolsDigest: entry.proposal.digest, state: 'active', reviewedBy: grant.principal, reviewedAt: at });
    });
    return view(true);
  }

  async function remove(grant: ConnectorGrant, id: string): Promise<ConnectorRegistryView> {
    if (grant.authority !== 'manage') throw forbidden();
    if (builtIns.has(id)) throw invalid('Built-in connectors can be disconnected but not removed.');
    const entry = (await load()).connectors.find(row => row.id === id);
    if (!entry) throw notFound();
    if (!(await grant.stillManages())) throw forbidden();
    // Tombstone first (no new instance, no commit from any earlier epoch), then
    // purge, then delete the entry, then purge once more in case a racing
    // commit slipped in before it was refused.
    removing.add(id);
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    try {
      await mutate(registry => { const row = registry.connectors.find(item => item.id === id); if (row) row.removing = true; });
      // An entry whose instance cannot be built never stored credentials, so it
      // is still removed; a purge that fails keeps the tombstone (fail closed).
      let target: McpConnector | null = null;
      try { target = connectorFor(entry, true); } catch (error) { logUnexpected(`${id} remove`, error); }
      instances.delete(id);
      await target?.purge();
      await mutate(registry => { registry.connectors = registry.connectors.filter(item => item.id !== id); });
      await target?.purge();
      target?.close();
    } finally { removing.delete(id); }
    return view(true);
  }

  const denied = (): ConnectorGrant => ({ authority: 'read', principal: 'unverified', stillManages: async () => false });

  const registry = {
    /** Every `/api/connectors` route: the list, add, review, remove, each connector's connection and its OAuth callback. */
    async route(path: string, method: string, request: IncomingMessage, readBody: () => Promise<unknown>): Promise<RegistryReply | RegistryPage | null> {
      const admin = connectorAdminRoute(path), route = path === CONNECTORS_API || admin ? null : connectorRoute(path);
      if (path !== CONNECTORS_API && !admin && !route) return null;
      try {
        if (route?.action === 'callback') {
          const target = await connector(route.id);
          if (!target || method !== 'GET') return { kind: 'json', status: 404, body: { error: 'Unknown connector.' } };
          return { kind: 'page', page: await target.callback(new URL(`http://x${request.url ?? ''}`).searchParams) };
        }
        if (route) {
          const target = await connector(route.id);
          if (!target) return { kind: 'json', status: 404, body: { error: 'Unknown connector.' } };
          const reply = await target.handle(route.action, method, request, method === 'POST' ? await readBody() : undefined);
          return { kind: 'json', ...reply };
        }
        const grant = await options.authorize(request).catch(denied);
        if (!admin) {
          if (method === 'GET') return { kind: 'json', status: 200, body: await view(grant.authority === 'manage') };
          if (method === 'POST') return { kind: 'json', status: 200, body: await add(grant, await readBody()) };
          return { kind: 'json', status: 405, body: { error: 'Use the connector controls.' } };
        }
        if (method !== 'POST') return { kind: 'json', status: 405, body: { error: 'Use the connector controls.' } };
        const body = await readBody();
        if (admin.action === 'remove' && body !== undefined && !(object(body) && !Object.keys(body).length)) return { kind: 'json', status: 400, body: { error: 'This action takes no options.' } };
        return { kind: 'json', status: 200, body: admin.action === 'review' ? await review(grant, admin.id, body) : await remove(grant, admin.id) };
      } catch (error) {
        if (error instanceof ConnectorError) return { kind: 'json', status: error.status, body: { error: error.message, code: error.code } };
        logUnexpected(`${method} ${path}`, error);
        return { kind: 'json', status: 500, body: { error: 'The connector could not be updated. Try again.' } };
      }
    },
    /** Re-lists tools on every connected custom connector (drift → quarantine). */
    async healthCheck(): Promise<void> {
      for (const entry of (await load()).connectors) {
        if (!entry.removing && !removing.has(entry.id)) await (async () => connectorFor(entry).healthCheck())().catch(error => { if (!(error instanceof ConnectorError)) logUnexpected(`${entry.id} health check`, error); });
      }
    },
    /** Tools Ask may see this turn: reviewed, allowlisted tools of active, connected custom connectors. */
    async askTools(): Promise<AskConnectorTool[]> {
      const tools: AskConnectorTool[] = [];
      let skipped = 0;
      for (const entry of (await load()).connectors) {
        if (entry.state !== 'active' || entry.removing || removing.has(entry.id)) continue;
        // One unreadable entry is left out of this turn; the others still load.
        if ((await connectionOf(entry.id, async () => connectorFor(entry).state(), false)).status !== 'connected') continue;
        for (const tool of entry.proposal?.tools ?? []) {
          const toolClass = Object.hasOwn(entry.allowlist, tool.name) ? entry.allowlist[tool.name] : undefined;
          if (!toolClass) continue;
          if (tools.length >= MAX_ASK_TOOLS) { skipped++; continue; }
          tools.push({ connector: entry.id, label: entry.label, tool: tool.name, toolClass, description: tool.description, inputSchema: tool.inputSchema });
        }
      }
      // Fail soft: Ask starts with the first tools; the rest are left out and noted.
      if (skipped) console.warn(`[connectors] ${skipped} reviewed tools were left out of this Ask turn (limit ${MAX_ASK_TOOLS}).`);
      return tools;
    },
    /** One call from Ask, re-checked against the registry at call time. Credentials stay here. */
    async invoke(id: string, tool: string, args: Record<string, unknown>, approval: Approval | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
      if (signal?.aborted) throw new ConnectorError('stale', 'This call was stopped.', 409);
      const entry = (await load()).connectors.find(row => row.id === id);
      const toolClass = await registry.toolClass(id, tool);
      if (!entry || !toolClass || (toolClass !== 'read' && toolClass !== approval)) throw new ConnectorError('forbidden', 'That tool is not available.', 403);
      if (signal?.aborted) throw new ConnectorError('stale', 'This call was stopped.', 409);
      return connectorFor(entry).invoke(tool, args, approval, signal);
    },
    /** The binding Ask's broker mounts for one turn (`turn.integrations.mcpConnectors`).
     * `attended`: a person is in this Ask turn; consequential calls need it. */
    async askBinding(options: { attended?: boolean } = {}): Promise<BudMcpConnectors> {
      return { tools: await registry.askTools(), attended: options.attended === true, toolClass: registry.toolClass, invoke: registry.invoke };
    },
    /** How an exposed tool runs now, or null when it is no longer exposed. */
    async toolClass(id: string, tool: string): Promise<ToolClass | null> {
      const entry = (await load()).connectors.find(row => row.id === id);
      if (entry?.state !== 'active' || entry.removing || removing.has(id) || !Object.hasOwn(entry.allowlist, tool)) return null;
      const toolClass = entry.allowlist[tool]!;
      return toolClass !== 'consequential' || entry.consequentialEnabled?.[tool] ? toolClass : null;
    },
    close() { for (const instance of instances.values()) instance.close(); },
  };
  return registry;
}
