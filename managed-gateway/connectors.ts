/** Vendor-hosted connector custody. Desktop clients receive only a revocable
 * device credential; project/org keys never leave this process. Gmail is the
 * first admitted adapter. Do not turn this into an arbitrary HTTP proxy. */
import { OfficeMailbox } from './office-mailbox.ts';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { GatewayError, canonical, exact, id, integer, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import { authorizeGmailReadOnly, createGmailReadOnlyTransport, getGmailReadOnlyAccess, scanGmailReadOnly, readGmailPdfAttachment, type GmailReadOnlyBinding } from '../server/composio-gmail.ts';
import { parseMailScanRequest } from '../shared/mail-ingestion.ts';
import { parseSourceAttachmentRequest } from '../shared/source-attachments.ts';

export interface ConnectorDevice {
  id: string; companyId: string; licenseId: string; memberId: string; installationId: string;
  profile: string; tokenHash: string; active: boolean; expiresAt: number;
  /** Environment-variable reference on the protected server, never the secret. */
  projectKeyEnv: string; authConfigId: string; userId: string; accountId?: string;
  /** Per-device allowlist of admitted apps. Absent in a registry written before
   * the allowlist existed, which means the original Gmail-only grant; the
   * validator fills it in. An app outside this list is refused before any binding
   * is read, and an app with no adapter here is refused regardless of what a
   * registry entry claims. */
  apps?: string[];
}
/** Apps with an admitted read-only adapter in this service. */
const ADAPTERS = ['gmail'] as const;
const APP = /^[a-z][a-z0-9_]{0,31}$/;
export const DEFAULT_APPS = ['gmail'] as const;
const appsOf = (device: ConnectorDevice): string[] => device.apps ?? [...DEFAULT_APPS];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const TOKEN = /^rbc_[a-f0-9]{64}$/;
export function newConnectorCredential() { const token = `rbc_${randomBytes(32).toString('hex')}`; return { token, tokenHash: hash(token) }; }

export function validateConnectorDevices(value: unknown): ConnectorDevice[] {
  object(value); exact(value, ['version', 'devices']); requireThat(value.version === 1 && Array.isArray(value.devices) && value.devices.length <= 1000, 'invalid_connector_registry');
  const ids = new Set<string>(), tokens = new Set<string>();
  return value.devices.map((raw: unknown) => {
    object(raw); exact(raw, ['id','companyId','licenseId','memberId','installationId','profile','tokenHash','active','expiresAt','projectKeyEnv','authConfigId','userId', ...(raw.accountId !== undefined ? ['accountId'] : []), ...(raw.apps !== undefined ? ['apps'] : [])]);
    for (const key of ['id','companyId','licenseId','memberId','installationId','profile','authConfigId','userId']) id(raw[key]);
    requireThat(typeof raw.profile === 'string' && /^[a-z0-9-]{1,64}$/.test(raw.profile), 'invalid_connector_profile');
    requireThat(typeof raw.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(raw.tokenHash) && !tokens.has(raw.tokenHash), 'invalid_connector_credential');
    requireThat(typeof raw.projectKeyEnv === 'string' && /^REALBUD_COMPOSIO_PROJECT_[A-Z0-9_]{1,80}$/.test(raw.projectKeyEnv), 'invalid_connector_secret_reference');
    requireThat(typeof raw.active === 'boolean' && !ids.has(String(raw.id)), 'invalid_connector_device');
    integer(raw.expiresAt, Number.MAX_SAFE_INTEGER);
    if (raw.accountId !== undefined) { id(raw.accountId); requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(String(raw.accountId)), 'invalid_connector_account'); }
    // An entry written before the allowlist existed keeps its original Gmail-only grant.
    const apps = raw.apps === undefined ? ['gmail'] : raw.apps;
    requireThat(Array.isArray(apps) && apps.length > 0 && apps.length <= 8 && new Set(apps).size === apps.length
      && apps.every((app: unknown) => typeof app === 'string' && APP.test(app)), 'invalid_connector_apps');
    ids.add(String(raw.id)); tokens.add(raw.tokenHash);
    return { ...raw, apps } as unknown as ConnectorDevice;
  });
}

/** Re-read on every request so an operator revocation takes effect immediately.
 * Missing/malformed registry fails closed rather than using a cached old grant. */
export function connectorRegistry(path: string): ConnectorDevice[] {
  try {
    requireThat(statSync(path).isFile() && statSync(path).size <= 1_000_000, 'connector_registry_unavailable', 503);
    const bytes = readFileSync(path); requireThat(bytes.length <= 1_000_000, 'connector_registry_unavailable', 503);
    return validateConnectorDevices(JSON.parse(bytes.toString('utf8')));
  } catch { throw new GatewayError('connector_registry_unavailable', 503); }
}

type Transport = ReturnType<typeof createGmailReadOnlyTransport>;
interface Session { device: string; fingerprint: string; expiresAt: number; transport: Transport; busy: boolean; calls: number }
export interface ConnectorResponse { status: number; body?: unknown; session?: string }
export interface ConnectorOptions {
  ledger: UsageLedger; devices: () => ConnectorDevice[]; secret: (name: string) => string | undefined;
  access?: typeof getGmailReadOnlyAccess; authorize?: typeof authorizeGmailReadOnly; transport?: typeof createGmailReadOnlyTransport;
  scan?: typeof scanGmailReadOnly;
  attachment?: typeof readGmailPdfAttachment;
}
export class ManagedConnectors {
  readonly officeMailbox: OfficeMailbox;
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Set<string>();
  private readonly rates = new Map<string, { starts: number; count: number }>();
  private readonly options: ConnectorOptions;
  constructor(options: ConnectorOptions) {
    this.options = options;
    this.officeMailbox = new OfficeMailbox(options);
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS connector_links (device TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL)');
  }
  private current(token: string, profile: string): ConnectorDevice {
    requireThat(TOKEN.test(token), 'connector_unauthenticated', 401);
    const device = this.options.devices().find(item => item.tokenHash === hash(token));
    const now = this.options.ledger.now();
    // `expiresAt` is stored for registry compatibility but not enforced: it is a
    // copy of the entitlement expiry at provisioning time, so renewing the
    // entitlement would not renew it. The current entitlement below decides.
    requireThat(device && device.active && device.profile === profile, 'connector_access_denied', 403);
    const tenant = this.options.ledger.tenant(device.companyId);
    requireThat(tenant.active && tenant.licenseId === device.licenseId && tenant.serviceExpiresAt > now && now >= tenant.goLiveAt, 'service_unavailable', 402);
    return device;
  }
  /** An app reaches a provider only when this service has an adapter for it AND
   * the device's registry entry admits it. Anything else is refused before the
   * project key or the connected account is read. */
  private admit(device: ConnectorDevice, app: string): void {
    requireThat((ADAPTERS as readonly string[]).includes(app) && appsOf(device).includes(app), 'connector_app_not_admitted', 403);
  }
  private binding(device: ConnectorDevice): GmailReadOnlyBinding {
    const shared = this.officeMailbox.binding(device); if (shared) return shared;
    const apiKey = this.options.secret(device.projectKeyEnv);
    requireThat(typeof apiKey === 'string' && /^ak_[A-Za-z0-9_-]{5,1000}$/.test(apiKey), 'connector_not_configured', 503);
    const binding = { apiKey, authConfigId: device.authConfigId, userId: device.userId, accountId: device.accountId };
    const saved = this.link(device);
    if (!binding.accountId && saved?.state === 'ready' && saved.result) {
      const result = JSON.parse(saved.result) as { accountId: string };
      binding.accountId = result.accountId;
    }
    return binding;
  }
  private linkIdentity(device: ConnectorDevice): string {
    return hash(canonical({ companyId: device.companyId, memberId: device.memberId, installationId: device.installationId,
      profile: device.profile, projectKeyEnv: device.projectKeyEnv, authConfigId: device.authConfigId, userId: device.userId }));
  }
  private link(device: ConnectorDevice) {
    const row = this.options.ledger.db.get<{ binding: string; state: string; result: string | null; created: number }>('SELECT * FROM connector_links WHERE device=?', device.id);
    if (row && row.binding !== this.linkIdentity(device)) throw new GatewayError('connector_binding_changed_needs_recovery', 409);
    return row;
  }
  async handle(input: { token: string; profile: string; method: string; path: string; body?: unknown; session?: string; policyRevision?: number; signal: AbortSignal }): Promise<ConnectorResponse> {
    const device = this.current(input.token, input.profile), now = this.options.ledger.now();
    const policy=this.officeMailbox.policy(device.companyId);
    if (input.path !== '/v1/connectors/status' && input.path !== '/v1/connectors/authorize') {
      requireThat((policy.mode === 'personal' && policy.revision === 0 && input.policyRevision === undefined) || input.policyRevision === policy.revision, 'office_mailbox_review_required', 409);
    }
    // Only bounded read/connection operations are admitted. No caller may choose
    // the upstream URL, project key, provider user or connected account.
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, rate] of this.rates) if (rate.starts + 60_000 <= now) this.rates.delete(key);
    const rate = this.rates.get(device.id) ?? { starts: now, count: 0 };
    requireThat(rate.count < 120, 'connector_rate_limited', 429); rate.count++; this.rates.set(device.id, rate);
    requireThat(!this.inflight.has(device.id), 'connector_busy', 409); this.inflight.add(device.id);
    const fingerprint = hash(this.officeMailbox.fingerprint(device));
    const current = () => { input.signal.throwIfAborted(); requireThat(hash(this.officeMailbox.fingerprint(this.current(input.token, input.profile))) === fingerprint, 'connector_binding_changed', 409); };
    try {
      if (input.path === '/v1/connectors/mail-attachment' && input.method === 'POST') {
        const source=parseSourceAttachmentRequest(input.body);this.admit(device,'gmail');
        const binding=this.binding(device);
        const assertAuthority=()=>{current();requireThat(this.binding(this.current(input.token,input.profile)).accountId===source.accountId,'mail_attachment_account_binding_changed',409);};
        requireThat(binding.accountId===source.accountId,'mail_attachment_account_binding_changed',409);assertAuthority();
        const result=await(this.options.attachment??readGmailPdfAttachment)({...binding,assertAuthority},source,input.signal);
        assertAuthority();return {status:200,body:result};
      }
      if (input.path === '/v1/connectors/mail-scan' && input.method === 'POST') {
        object(input.body);
        // A status read and a scan are separate requests. Require the exact
        // account the desktop reviewed before any provider access. Legacy flat
        // requests intentionally fail closed rather than selecting a new source.
        const expectedAccountId = input.body.expectedAccountId;
        requireThat(typeof expectedAccountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(expectedAccountId), 'mail_scan_account_review_required', 400);
        exact(input.body, ['expectedAccountId', 'scope']);
        let request;
        try { request = parseMailScanRequest(input.body.scope, now); } catch { throw new GatewayError('invalid_mail_scan_request', 400); }
        this.admit(device, 'gmail');
        const binding = this.binding(device);
        const assertScanAuthority = () => {
          current();
          // Include account selection restored from connector_links, which can
          // change independently of the device registry fingerprint.
          requireThat(this.binding(this.current(input.token, input.profile)).accountId === expectedAccountId, 'mail_scan_account_binding_changed', 409);
        };
        requireThat(binding.accountId === expectedAccountId, 'mail_scan_account_binding_changed', 409);
        assertScanAuthority();
        const result = await (this.options.scan ?? scanGmailReadOnly)({ ...binding, assertAuthority: assertScanAuthority }, request, input.signal);
        assertScanAuthority(); return { status: 200, body: result };
      }
      if (input.path === '/v1/connectors/status' && input.method === 'GET') {
        this.admit(device, 'gmail');
        const policy = this.officeMailbox.policy(device.companyId);
        const result = policy.mode === 'shared' && !this.officeMailbox.readyForDevice(device)
          ? { checkedAt: new Date(now).toISOString(), services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } }
          : await (this.options.access ?? getGmailReadOnlyAccess)({ ...this.binding(device), assertAuthority: current });
        current();
        return { status: 200, body: { ...result, sourceKind: policy.mode === 'shared' ? 'office_shared' : 'personal', policyRevision: policy.revision, managed: true, apps: appsOf(device), serviceExpiresAt: this.options.ledger.tenant(device.companyId).serviceExpiresAt } };
      }
      if (input.path === '/v1/connectors/authorize' && input.method === 'POST') {
        requireThat(this.officeMailbox.policy(device.companyId).mode === 'personal', 'office_mailbox_owner_authorization_required', 403);
        object(input.body); exact(input.body, ['app']);
        requireThat(typeof input.body.app === 'string' && APP.test(input.body.app), 'connector_app_not_admitted', 403);
        this.admit(device, input.body.app as string);
        const existing = this.link(device);
        /** The account a lapsed link initiated, once the provider has said it never connected. */
        let lapsed: string | null | undefined;
        if (existing) {
          requireThat(existing.state === 'ready' && existing.result, 'connector_link_outcome_unknown', 409);
          const result = JSON.parse(existing.result) as { url: string; accountId?: string; expiresAt: string };
          if (Date.parse(result.expiresAt) > now) return { status: 200, body: { url: result.url } };
          // The sign-in link lapsed. It is replaced by a fresh one only once the
          // provider confirms the account it initiated never connected: an
          // account that did connect is this device's account (never re-linked
          // to another), and a provider that cannot say keeps the hold.
          if (result.accountId) {
            let status: Awaited<ReturnType<typeof getGmailReadOnlyAccess>>;
            try { status = await (this.options.access ?? getGmailReadOnlyAccess)({ ...this.binding(device), assertAuthority: current }); }
            catch { throw new GatewayError('connector_link_expired_needs_recovery', 409); }
            current();
            requireThat(!(status.services.gmail?.accounts ?? []).some(account => account.id === result.accountId && account.status === 'ACTIVE'), 'connector_account_already_bound', 409);
          }
          lapsed = result.accountId ?? null;
        }
        // Never the lapsed link's account: only a registry-pinned one binds here.
        const binding = { ...this.binding(device), accountId: device.accountId };
        requireThat(!binding.accountId, 'connector_account_already_bound', 409);
        this.options.ledger.db.transaction(() => {
          // One link per device: a replacement takes over the row, so a lost
          // reply on the way is held exactly as a first attempt's would be.
          if (lapsed === undefined) this.options.ledger.db.run('INSERT INTO connector_links(device,binding,state,created) VALUES(?,?,?,?)', device.id, this.linkIdentity(device), 'unknown', now);
          else this.options.ledger.db.run('UPDATE connector_links SET state=?,result=NULL,created=? WHERE device=? AND binding=?', 'unknown', now, device.id, this.linkIdentity(device));
          this.options.ledger.db.append(device.companyId, lapsed === undefined ? 'connector_link_requested' : 'connector_link_replaced', null, now, { deviceId: device.id, ...(lapsed ? { lapsedAccountId: lapsed } : {}) });
        });
        const result = await (this.options.authorize ?? authorizeGmailReadOnly)({ ...binding, assertAuthority: current });
        // Persist the receipt even if access was revoked during the external
        // operation; do not lose evidence or repeat link creation on retry.
        this.options.ledger.db.run('UPDATE connector_links SET state=?,result=? WHERE device=? AND binding=?', 'ready', JSON.stringify(result), device.id, this.linkIdentity(device));
        current(); return { status: 200, body: { url: result.url } };
      }
      if (input.path !== '/v1/connectors/mcp' || input.method !== 'POST') throw new GatewayError('not_found', 404);
      object(input.body);
      const message = input.body;
      requireThat(message.jsonrpc === '2.0' && typeof message.method === 'string' && Object.keys(message).every(key => ['jsonrpc','id','method','params'].includes(key)), 'invalid_connector_rpc');
      if (message.id === undefined) {
        requireThat(message.method === 'notifications/initialized' && typeof input.session === 'string', 'invalid_connector_notification');
        const session = this.sessions.get(input.session);
        requireThat(session?.device === device.id && session.fingerprint === fingerprint, 'connector_session_expired', 409);
        return { status: 202 };
      }
      requireThat((typeof message.id === 'string' && message.id.length <= 100) || (typeof message.id === 'number' && Number.isSafeInteger(message.id)), 'invalid_connector_rpc_id');
      if (message.method === 'initialize') {
        // The MCP transport is the Gmail adapter's; the admitted read-only method
        // list below is unchanged and stays the only thing a session may call.
        this.admit(device, 'gmail');
        requireThat(!input.session && this.sessions.size < 128 && [...this.sessions.values()].filter(item => item.device === device.id).length < 8, 'connector_session_limit', 429);
        // Do not capture this HTTP request's abort signal in a multi-request
        // session. Revalidate the live device/tenant before each adapter request.
        const transport = (this.options.transport ?? createGmailReadOnlyTransport)({ ...this.binding(device), assertAuthority: () => {
          requireThat(hash(this.officeMailbox.fingerprint(this.current(input.token, input.profile))) === fingerprint, 'connector_binding_changed', 409);
        } });
        const result = await transport.request('initialize', message.params, input.signal); current();
        const key = randomBytes(32).toString('hex');
        this.sessions.set(key, { device: device.id, fingerprint, expiresAt: now + 5 * 60_000, transport, busy: false, calls: 0 });
        return { status: 200, session: key, body: { jsonrpc: '2.0', id: message.id, result } };
      }
      const session = input.session ? this.sessions.get(input.session) : undefined;
      requireThat(session && session.device === device.id && session.fingerprint === fingerprint, 'connector_session_expired', 409);
      requireThat(!session.busy && session.calls < 64 && ['tools/list','tools/call','ping'].includes(message.method), 'connector_method_denied', 403);
      session.busy = true; session.calls++;
      try {
        current();
        const result = await session.transport.request(message.method, message.params, input.signal);
        current();
        // The adapter returns only projected read results. No sessions, provider
        // credentials or arbitrary upstream headers are reflected to clients.
        return { status: 200, session: input.session, body: { jsonrpc: '2.0', id: message.id, result } };
      } finally { session.busy = false; }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('connector_check_failed', 502);
    } finally { this.inflight.delete(device.id); }
  }
}
