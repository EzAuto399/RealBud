import { classifyAppTool, type AppToolAnnotations } from './app-tool-policy.ts';
/** A connector: one OAuth-connected MCP server, per workspace, as the renderer
 * sees it. The server owns every token; nothing here grants access by itself.
 * Only the office owner or a service admin connects or disconnects a
 * connector; members read its status. Redbark is the first preset. */

export const CONNECTOR_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const connectorConnectionApi = (id: string) => `/api/connectors/${id}/connection`;
/** Loopback OAuth redirect. Reached by the person's browser, not the renderer:
 * authenticated by the single-use `state`, not by a RealBud session. */
export const connectorCallbackPath = (id: string) => `/api/connectors/${id}/oauth/callback`;

export const CONNECTOR_ACTIONS = ['state', 'start', 'check', 'disconnect', 'token'] as const;
export type ConnectorAction = typeof CONNECTOR_ACTIONS[number];

/** Earlier per-connector paths kept working as aliases. */
const ALIASES: Record<string, string> = { '/api/redbark': 'redbark' };

/** Maps a request path to a connector route, or null. */
export function connectorRoute(path: string): { id: string; action: ConnectorAction | 'callback' } | null {
  let id: string | undefined, rest: string;
  const generic = /^\/api\/connectors\/([^/]+)(\/.*)$/.exec(path);
  if (generic) { id = generic[1]; rest = generic[2]!; }
  else {
    const alias = Object.keys(ALIASES).find(prefix => path.startsWith(`${prefix}/`));
    if (!alias) return null;
    id = ALIASES[alias]; rest = path.slice(alias.length);
  }
  if (!id || !CONNECTOR_ID.test(id)) return null;
  if (rest === '/oauth/callback') return { id, action: 'callback' };
  if (rest === '/connection') return { id, action: 'state' };
  const action = /^\/connection\/(start|check|disconnect|token)$/.exec(rest)?.[1] as ConnectorAction | undefined;
  return action ? { id, action } : null;
}

export const CONNECTOR_STATUSES = ['not_connected', 'connecting', 'connected', 'needs_reconnect', 'unavailable'] as const;
export type ConnectorStatus = typeof CONNECTOR_STATUSES[number];

/** The only sentences the server puts in `reason`: fixed text, never provider output. */
export const CONNECTOR_REASONS = {
  signInAgain: 'This connection needs the office to sign in again. Connect again to continue.',
  unreachable: 'The connected service could not be reached. Try again shortly.',
  registrationLimited: 'The service is limiting new connections right now. Try again later.',
  notVerified: 'The service sign-in details could not be verified. Try again later.',
  tooBroad: 'The service granted more access than RealBud asked for, so RealBud did not keep it. Connect again and approve only what is listed.',
} as const;

export interface ConnectorAccount {
  /** What the verified read returned, for showing only (e.g. bank names). */
  label: string;
  verifiedAt: number;
}

export interface ConnectorState {
  version: 1;
  connector: string;
  status: ConnectorStatus;
  /** Present only when status is `connected` or `needs_reconnect`. */
  account: ConnectorAccount | null;
  /** Increments on every connect, reconnect or disconnect. */
  generation: number;
  reason: string | null;
  /** Whether this RealBud person may connect or disconnect it. */
  canManage: boolean;
}

export interface ConnectorStart { authorizeUrl: string }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

export function parseConnectorState(v: unknown, connector?: string): ConnectorState | null {
  if (!object(v) || !exact(v, ['version', 'connector', 'status', 'account', 'generation', 'reason', 'canManage']) || v.version !== 1) return null;
  if (typeof v.connector !== 'string' || !CONNECTOR_ID.test(v.connector) || (connector !== undefined && v.connector !== connector)) return null;
  if (!CONNECTOR_STATUSES.includes(v.status as ConnectorStatus) || typeof v.canManage !== 'boolean') return null;
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0) return null;
  if (v.reason !== null && !text(v.reason, 300)) return null;
  const status = v.status as ConnectorStatus;
  let account: ConnectorAccount | null = null;
  if (v.account !== null) {
    const a = v.account;
    if (!object(a) || !exact(a, ['label', 'verifiedAt']) || !text(a.label, 300) || !Number.isSafeInteger(a.verifiedAt) || (a.verifiedAt as number) <= 0) return null;
    account = { label: a.label as string, verifiedAt: a.verifiedAt as number };
  }
  if ((status === 'connected') !== (account !== null) && status !== 'needs_reconnect') return null;
  return { version: 1, connector: v.connector, status, account, generation: v.generation as number, reason: v.reason as string | null, canManage: v.canManage };
}

/** A sign-in link is accepted only on https and, when given, on the expected origin. */
export function parseConnectorStart(v: unknown, origin?: string): ConnectorStart | null {
  if (!object(v) || !exact(v, ['authorizeUrl']) || typeof v.authorizeUrl !== 'string') return null;
  try {
    const url = new URL(v.authorizeUrl);
    return url.protocol === 'https:' && !url.username && !url.password && (origin === undefined || url.origin === origin) ? { authorizeUrl: url.toString() } : null;
  } catch { return null; }
}

// ── Custom connectors (added by server address) ───────────────────────────


export const CONNECTORS_API = '/api/connectors';
export const connectorEntryApi = (id: string) => `/api/connectors/${id}`;
export type ConnectorToolClass = 'read' | 'write' | 'consequential';
export const CONNECTOR_ENTRY_STATES = ['pending_review', 'active', 'quarantined'] as const;
export type ConnectorEntryState = typeof CONNECTOR_ENTRY_STATES[number];
export const MAX_TOOL_DESCRIPTION = 300;
/** `/api/connectors/<id>/review` and `/api/connectors/<id>/remove` (custom connectors only). */
export function connectorAdminRoute(path: string): { id: string; action: 'review' | 'remove' } | null {
  const match = /^\/api\/connectors\/([^/]+)\/(review|remove)$/.exec(path);
  return match && CONNECTOR_ID.test(match[1]!) ? { id: match[1]!, action: match[2] as 'review' | 'remove' } : null;
}

/** Writes whose effect leaves the office or changes who can do what: sending,
 * paying, publishing, sharing, approving, account changes. Never callable from
 * Ask, because RealBud cannot show verified facts for an arbitrary service. */
const CONSEQUENTIAL_TOKENS = new Set(['SEND', 'PAY', 'PAYMENT', 'PAYMENTS', 'TRANSFER', 'CHARGE', 'REFUND', 'REPLY', 'FORWARD', 'PUBLISH',
  'INVITE', 'SHARE', 'APPROVE', 'SUBMIT', 'SIGN', 'ACCOUNT', 'ACCOUNTS', 'USER', 'USERS', 'MEMBER', 'MEMBERS', 'EMAIL', 'SMS', 'MESSAGE', 'NOTIFY', 'POST']);

/** Classifies one server tool with the shared app-tool policy. Annotations can
 * only make it stricter; an unknown or ambiguous name is a write. */
export function classifyConnectorTool(name: string, annotations: AppToolAnnotations | null = null): ConnectorToolClass {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]+/g, '_').toUpperCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!/^[A-Z0-9_]{1,120}$/.test(normalized)) return 'consequential';
  const policy = classifyAppTool(`MCP_${normalized}`, { app: 'MCP', annotations });
  if (policy === 'blocked') return 'consequential';
  if (policy === 'read') return 'read';
  return normalized.split('_').some(token => CONSEQUENTIAL_TOKENS.has(token)) ? 'consequential' : 'write';
}

/** The words the owner must accept before enabling a consequential tool on an added service. */
export const CONSEQUENTIAL_WARNING = "RealBud can't verify what this service does; the card shows only the arguments the tool receives.";

/** Prose keys in a tool's input schema are the service's own words: removed
 * (at every depth) before a schema is stored or shown to Bud. Enum strings are
 * capped; past 12 levels a schema is replaced with a plain object. */
const SCHEMA_PROSE = new Set(['description', 'title', 'examples', 'example', '$comment', 'default', 'markdownDescription']);
export function stripSchemaProse(value: unknown, depth = 0): unknown {
  if (depth > 12) return {};
  if (Array.isArray(value)) return value.slice(0, 200).map(item => stripSchemaProse(item, depth + 1));
  if (typeof value === 'string') return value.slice(0, 200);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SCHEMA_PROSE.has(key) && !key.startsWith('x-')).map(([key, item]) => [key, stripSchemaProse(item, depth + 1)]));
}

/** `toolClass` is the name/annotation heuristic (it can only be stricter).
 * `enabled`: Bud may call it — through a card every time unless `trusted`.
 * `trusted`: an owner marked this read-looking tool to run without a card. */
export interface ConnectorToolView { name: string; toolClass: ConnectorToolClass; description: string; enabled: boolean; trusted: boolean }
export interface ConnectorEntryView {
  id: string; label: string; serverUrl: string; auth: 'oauth' | 'header'; builtIn: boolean;
  state: ConnectorEntryState; reviewedAt: string | null;
  /** The listed tools awaiting (or last given) review; null until first listed. */
  proposalDigest: string | null;
  /** The service listed more than RealBud can store for review. */
  oversized: boolean;
  tools: ConnectorToolView[];
  connection: ConnectorState;
}
export interface ConnectorRegistryView { version: 1; canManage: boolean; connectors: ConnectorEntryView[] }

const CLASSES: readonly string[] = ['read', 'write', 'consequential'];
function parseTool(v: unknown): ConnectorToolView | null {
  if (!object(v) || !exact(v, ['name', 'toolClass', 'description', 'enabled', 'trusted']) || typeof v.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(v.name)) return null;
  if (!CLASSES.includes(v.toolClass as string) || typeof v.description !== 'string' || v.description.length > MAX_TOOL_DESCRIPTION || typeof v.enabled !== 'boolean' || typeof v.trusted !== 'boolean') return null;
  if (v.trusted && (!v.enabled || v.toolClass !== 'read')) return null;
  return { name: v.name, toolClass: v.toolClass as ConnectorToolClass, description: v.description, enabled: v.enabled, trusted: v.trusted };
}
export function parseConnectorEntry(v: unknown): ConnectorEntryView | null {
  if (!object(v) || !exact(v, ['id', 'label', 'serverUrl', 'auth', 'builtIn', 'state', 'reviewedAt', 'proposalDigest', 'oversized', 'tools', 'connection']) || typeof v.oversized !== 'boolean') return null;
  if (typeof v.id !== 'string' || !CONNECTOR_ID.test(v.id) || !text(v.label, 80) || typeof v.serverUrl !== 'string' || !/^https:\/\//.test(v.serverUrl) || v.serverUrl.length > 2048) return null;
  if ((v.auth !== 'oauth' && v.auth !== 'header') || typeof v.builtIn !== 'boolean' || !CONNECTOR_ENTRY_STATES.includes(v.state as ConnectorEntryState)) return null;
  if ((v.reviewedAt !== null && !text(v.reviewedAt, 40)) || (v.proposalDigest !== null && (typeof v.proposalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.proposalDigest)))) return null;
  if (!Array.isArray(v.tools) || v.tools.length > 300) return null;
  const tools = v.tools.map(parseTool);
  const connection = parseConnectorState(v.connection, v.id);
  if (tools.some(tool => tool === null) || !connection) return null;
  return { id: v.id, label: v.label as string, serverUrl: v.serverUrl, auth: v.auth, builtIn: v.builtIn, state: v.state as ConnectorEntryState,
    reviewedAt: v.reviewedAt as string | null, proposalDigest: v.proposalDigest as string | null, oversized: v.oversized, tools: tools as ConnectorToolView[], connection };
}
export function parseConnectorRegistry(v: unknown): ConnectorRegistryView | null {
  if (!object(v) || !exact(v, ['version', 'canManage', 'connectors']) || v.version !== 1 || typeof v.canManage !== 'boolean' || !Array.isArray(v.connectors) || v.connectors.length > 50) return null;
  const connectors = v.connectors.map(parseConnectorEntry);
  return connectors.some(entry => entry === null) ? null : { version: 1, canManage: v.canManage, connectors: connectors as ConnectorEntryView[] };
}
