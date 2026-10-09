/** Vendor-hosted connector custody. Desktop clients receive only a revocable
 * device credential; project/org keys never leave this process. Gmail's saved
 * workflows (mail scan, PDF attachment) keep the reviewed read-only adapter;
 * Ask's Gmail session runs the full Gmail toolkit under the shared mailbox
 * policy (`gmailToolkit`). Any other Composio toolkit is admitted on demand
 * into the office's own project (see `admitApp`). Do not turn this into an
 * arbitrary HTTP proxy: every upstream call is one of the bounded adapters'. */
import { OfficeMailbox, type MailboxSource } from './office-mailbox.ts';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { GatewayError, canonical, exact, id, integer, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import { authorizeGmailReadOnly, createGmailReadOnlyTransport, getGmailReadOnlyAccess, scanGmailReadOnly, readGmailPdfAttachment, type GmailReadOnlyBinding } from '../server/composio-gmail.ts';
import { parseMailScanRequest } from '../shared/mail-ingestion.ts';
import { parseSourceAttachmentRequest } from '../shared/source-attachments.ts';
import { TOOLKIT_SLUG, type ComposioAuthConfigClient, type KeyScheme } from './composio-auth-config.ts';
import { composioAppAdapter, type AppAccount, type AppBinding, type AppTool, type ComposioAppAdapter } from './composio-apps.ts';
import { classifyAppToolCall, MAIL_SENDS } from '../shared/app-tool-policy.ts';
import { parseConnectedMailBindings, unsupportedConnectedMailTool, connectedMailSenderArgsAllowed, verifiedMailAddress, type ConnectedMailBinding } from '../shared/connected-app-binding.ts';
import { serialized } from './serialized.ts';
import { ComposioTriggers, officeUserId, triggerSpec } from './composio-triggers.ts';

export interface ConnectorDevice {
  id: string; companyId: string; licenseId: string; memberId: string; installationId: string;
  profile: string; tokenHash: string; active: boolean; expiresAt: number;
  /** Environment-variable reference on the protected server, never the secret. */
  projectKeyEnv: string;
  /** Gmail's reviewed read-only auth configuration in the office project. Other
   * apps' configurations live in the ledger's `connector_office_apps` table,
   * one per office and app, created on demand. */
  authConfigId: string; userId: string; accountId?: string;
  /** Per-device allowlist of admitted apps. Absent in a registry written before
   * the allowlist existed, which means the original Gmail-only grant; the
   * validator fills it in. An app outside this list is refused before any binding
   * is read. A person's "connect <app>" appends to it through `admitApp`. */
  apps?: string[];
}
const APP = TOOLKIT_SLUG;
export const MAX_DEVICE_APPS = 64;
export const DEFAULT_APPS = ['gmail'] as const;
const appsOf = (device: ConnectorDevice): string[] => device.apps ?? [...DEFAULT_APPS];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Advertised at session initialize: this gateway verifies a send's reviewed
 * mail binding whenever the desktop attaches one. */
export const MAIL_BINDING_CAPABILITY = 'realbud/reviewed-mail-binding';
/** The primary address from an OUTLOOK_GET_PROFILE result (Graph /me: `mail`,
 * else the sign-in name a personal account sends as). UNVERIFIED: whether
 * Composio nests the user under `response_data`; both shapes are read. */
function outlookAddress(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (result.isError || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return undefined;
  let value: unknown; try { value = JSON.parse(content[0].text); } catch { return undefined; }
  const object = (row: unknown): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row);
  const user = object(value) && object(value.response_data) ? value.response_data : value;
  if (!object(user)) return undefined;
  const address = user.mail ?? user.userPrincipalName;
  return verifiedMailAddress(address) ? address : undefined;
}
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
    requireThat(Array.isArray(apps) && apps.length > 0 && apps.length <= MAX_DEVICE_APPS && new Set(apps).size === apps.length
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

interface Transport { request(method: string, params: unknown, signal: AbortSignal): Promise<Record<string, any>> }
interface Session { device: string; fingerprint: string; expiresAt: number; transport: Transport; busy: boolean; calls: number }
export interface ConnectorResponse { status: number; body?: unknown; session?: string }
type ServiceStatus = { connected: boolean; status: string; accounts: AppAccount[]; accountSelectionRequired: false };
const NOT_CONNECTED: ServiceStatus = { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false };
export interface ConnectorOptions {
  ledger: UsageLedger; devices: () => ConnectorDevice[]; secret: (name: string) => string | undefined;
  access?: typeof getGmailReadOnlyAccess; authorize?: typeof authorizeGmailReadOnly;
  /** Ask's Gmail MCP transport; defaults to the full-toolkit `gmailToolkit`. */
  transport?: typeof createGmailReadOnlyTransport;
  /** Host/test adapter for the existing fixed account-bound Gmail profile reader. */
  mailProfile?: typeof createGmailReadOnlyTransport;
  scan?: typeof scanGmailReadOnly;
  attachment?: typeof readGmailPdfAttachment;
  /** On-demand admission of any Composio toolkit. Both are needed; without them
   * a device can only use the apps its registry entry already admits. */
  authConfigs?: ComposioAuthConfigClient;
  /** Appends `app` to one device's registry allowlist (provisioning's
   * `updateRegistry`). Must be idempotent and leave every other device untouched. */
  admitApp?: (deviceId: string, app: string) => void;
  /** Moves one device's Gmail binding from auth config `from` to `to` in the
   * registry, only while it still records `from`; every other device untouched.
   * With `authConfigs.gmailAuthConfigName`, it lets a device provisioned on a
   * Gmail config nobody could connect (see LEGACY_GMAIL_AUTH_CONFIG_NAME) move
   * to the current one on its next connect. Without it the binding never moves. */
  rebindGmail?: (deviceId: string, from: string, to: string) => void;
  /** Generic toolkit adapter; defaults to the real Composio project API. */
  apps?: ComposioAppAdapter;
}
const TOOL_CACHE_TTL_MS = 10 * 60_000, TOOL_CACHE_MAX = 256;
/** Prefix each listed tool's description (tool names and calls are unchanged). */
const labelled = (transport: Transport, label: string): Transport => !label ? transport : { async request(method, params, signal) {
  const result = await transport.request(method, params, signal);
  return method === 'tools/list' && Array.isArray(result?.tools) ? { ...result, tools: result.tools.map((tool: Record<string, unknown>) => ({ ...tool, description: label + String(tool.description ?? '') })) } : result;
} };
export class ManagedConnectors {
  readonly officeMailbox: OfficeMailbox;
  /** Composio event triggers: the signed webhook, the per-device event pull and the trigger switch. */
  readonly triggers: ComposioTriggers;
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Set<string>();
  private readonly rates = new Map<string, { starts: number; count: number }>();
  private readonly toolCache = new Map<string, { at: number; tools: AppTool[] }>();
  private readonly options: ConnectorOptions;
  private readonly apps: ComposioAppAdapter;
  constructor(options: ConnectorOptions) {
    this.options = options;
    this.apps = options.apps ?? composioAppAdapter();
    // A mode change stops the triggers on a mailbox the new mode no longer serves.
    this.officeMailbox = new OfficeMailbox(options, (company, authority) => this.rebindOfficeGmail(company, authority),
      (company, retired) => this.triggers.disable(company, row => row.user_id === officeUserId(company) ? retired.office : retired.personal, 'mailbox_mode_changed'));
    this.triggers = new ComposioTriggers({ ledger: options.ledger, devices: options.devices, secret: options.secret, mailbox: this.officeMailbox, apps: this.apps });
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS connector_links (device TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL)');
    // One office-wide Composio-managed auth config per app, created on demand.
    // `pending` is the durable create intent: never a second POST for it.
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS connector_office_apps (company TEXT NOT NULL, app TEXT NOT NULL, state TEXT NOT NULL, auth_config TEXT, created INTEGER NOT NULL, PRIMARY KEY(company, app))');
    // Sign-in links for non-Gmail apps, one per device and app. Gmail keeps `connector_links`.
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS connector_app_links (device TEXT NOT NULL, app TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, PRIMARY KEY(device, app))');
  }
  /** The binding fingerprint a session is pinned to. The apps allowlist is left
   * out on purpose: connecting another app must not break sessions in flight. */
  private fingerprint(device: ConnectorDevice, source: MailboxSource): string {
    const { apps: _apps, ...pinned } = device;
    return hash(this.officeMailbox.fingerprint(pinned as ConnectorDevice) + source);
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
  /** An app reaches a provider only when the device's registry entry admits it
   * and the office holds a configuration for it (Gmail: the device's own). */
  private admit(device: ConnectorDevice, app: string): void {
    requireThat(APP.test(app) && appsOf(device).includes(app), 'connector_app_not_admitted', 403);
    if (app !== 'gmail') requireThat(this.officeApp(device.companyId, app)?.state === 'ready', 'connector_app_not_admitted', 403);
  }
  private projectKey(device: ConnectorDevice): string {
    const apiKey = this.options.secret(device.projectKeyEnv);
    requireThat(typeof apiKey === 'string' && /^ak_[A-Za-z0-9_-]{5,1000}$/.test(apiKey), 'connector_not_configured', 503);
    return apiKey;
  }
  private binding(device: ConnectorDevice, source?: MailboxSource): GmailReadOnlyBinding {
    const shared = this.officeMailbox.binding(device, source); if (shared) return shared;
    const binding: GmailReadOnlyBinding = { apiKey: this.projectKey(device), authConfigId: device.authConfigId, userId: device.userId, accountId: device.accountId, acceptComposioManagedScopes: true };
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

  // ── Gmail auth-config rebinding ──
  /** The office's current Gmail auth config, found or created once in the
   * office's own project under the name the client resolves now. The durable
   * create intent is a `connector_office_apps` row keyed by that config name
   * (never a toolkit slug, so it cannot collide with an app's row). Serialized
   * with provisioning's Gmail resolution for the same office. */
  private async currentGmailConfig(device: ConnectorDevice, current: () => void): Promise<string> {
    const authConfigs = this.options.authConfigs!;
    const name = authConfigs.gmailAuthConfigName!();
    const company = device.companyId, now = () => this.options.ledger.now();
    return serialized(`composio-auth-config:${company}`, async () => {
      const office = this.officeApp(company, name);
      if (office?.state === 'ready' && office.auth_config) return office.auth_config;
      const projectKey = this.projectKey(device);
      current();
      let authConfigId: string;
      try {
        authConfigId = await authConfigs.resolveGmail({ projectKey, allowCreate: !office, beforeCreate: () => {
          this.options.ledger.db.transaction(() => {
            this.options.ledger.db.run('INSERT INTO connector_office_apps(company,app,state,created) VALUES(?,?,?,?)', company, name, 'pending', now());
            this.options.ledger.db.append(company, 'connector_gmail_config_requested', null, now(), { name, deviceId: device.id });
          });
        } });
      } catch (error) {
        if (error instanceof GatewayError && error.code === 'connector_auth_config_rejected') {
          this.options.ledger.db.transaction(() => {
            this.options.ledger.db.run('DELETE FROM connector_office_apps WHERE company=? AND app=? AND state=?', company, name, 'pending');
            this.options.ledger.db.append(company, 'connector_gmail_config_rejected', null, now(), { name, deviceId: device.id });
          });
        }
        throw error;
      }
      current();
      this.options.ledger.db.transaction(() => {
        this.options.ledger.db.run('INSERT INTO connector_office_apps(company,app,state,auth_config,created) VALUES(?,?,?,?,?) ON CONFLICT(company,app) DO UPDATE SET state=excluded.state, auth_config=excluded.auth_config', company, name, 'ready', authConfigId, now());
        this.options.ledger.db.append(company, 'connector_gmail_config_ready', null, now(), { name, authConfigId });
      });
      return authConfigId;
    });
  }
  /**
   * Move a device off a Gmail auth config nobody could connect. Only when the
   * rebinding seam is composed, the device records a config other than the
   * office's current one, no account is pinned in its registry entry, and the
   * provider confirms no ACTIVE Gmail account under its recorded config. A
   * device with an active account, or a provider that cannot answer, stays
   * exactly as it is. The device's old link row is removed first (journaled with
   * the account it initiated), then the registry moves; a crash between the two
   * leaves the device on its old config with no link, which the next connect
   * repeats safely. Returns true when the registry moved.
   */
  private async rebindGmail(device: ConnectorDevice, current: () => void): Promise<boolean> {
    const { authConfigs, rebindGmail } = this.options;
    if (!authConfigs?.gmailAuthConfigName || !rebindGmail || device.accountId) return false;
    const target = await this.currentGmailConfig(device, current);
    if (device.authConfigId === target) return false;
    const recorded: GmailReadOnlyBinding = { apiKey: this.projectKey(device), authConfigId: device.authConfigId, userId: device.userId, acceptComposioManagedScopes: true, assertAuthority: current };
    let accounts: Array<{ status: string }>;
    try { accounts = (await (this.options.access ?? getGmailReadOnlyAccess)(recorded)).services.gmail?.accounts ?? []; }
    catch { throw new GatewayError('connector_gmail_rebind_unconfirmed', 409); }
    current();
    if (accounts.some(account => account.status === 'ACTIVE')) return false;
    const company = device.companyId, now = this.options.ledger.now();
    const old = this.options.ledger.db.get<{ state: string; result: string | null }>('SELECT state, result FROM connector_links WHERE device=?', device.id);
    const initiated = old?.result ? (JSON.parse(old.result) as { accountId?: string }).accountId : undefined;
    this.options.ledger.db.transaction(() => {
      this.options.ledger.db.run('DELETE FROM connector_links WHERE device=?', device.id);
      this.options.ledger.db.append(company, 'connector_gmail_rebind_requested', null, now, { deviceId: device.id, from: device.authConfigId, to: target,
        ...(old ? { previousLinkState: old.state } : {}), ...(initiated ? { lapsedAccountId: initiated } : {}) });
    });
    rebindGmail(device.id, device.authConfigId, target);
    this.options.ledger.db.append(company, 'connector_gmail_rebound', null, now, { deviceId: device.id, installationId: device.installationId, from: device.authConfigId, to: target });
    return true;
  }
  /** Shared-mailbox setup: every active device of the office must sit on one
   * Gmail config. Devices on a stale config with no active account move to the
   * current one first; any device that cannot move keeps the existing
   * `office_mailbox_configuration_conflict` refusal. */
  async rebindOfficeGmail(company: string, authority: () => void): Promise<void> {
    if (!this.options.authConfigs?.gmailAuthConfigName || !this.options.rebindGmail) return;
    for (const device of this.options.devices().filter(d => d.companyId === company && d.active)) {
      await this.rebindGmail(device, () => {
        authority();
        const now = this.options.devices().find(d => d.id === device.id);
        requireThat(now && now.active && now.authConfigId === device.authConfigId && now.tokenHash === device.tokenHash, 'connector_binding_changed', 409);
      });
    }
  }

  // ── Any other app: office auth config, per-device link, generic adapter ──
  private officeApp(company: string, app: string) {
    return this.options.ledger.db.get<{ state: string; auth_config: string | null; created: number }>('SELECT state, auth_config, created FROM connector_office_apps WHERE company=? AND app=?', company, app);
  }
  private appBinding(device: ConnectorDevice, app: string): AppBinding {
    const office = this.officeApp(device.companyId, app);
    requireThat(office?.state === 'ready' && office.auth_config, 'connector_app_not_admitted', 403);
    const binding: AppBinding = { apiKey: this.projectKey(device), authConfigId: office!.auth_config!, userId: device.userId };
    const saved = this.appLink(device, app, binding.authConfigId);
    if (saved?.state === 'ready' && saved.result) {
      const result = JSON.parse(saved.result) as { accountId?: string };
      if (result.accountId) binding.accountId = result.accountId;
    }
    return binding;
  }
  private appLinkIdentity(device: ConnectorDevice, app: string, authConfigId: string): string {
    return hash(canonical({ companyId: device.companyId, memberId: device.memberId, installationId: device.installationId,
      profile: device.profile, projectKeyEnv: device.projectKeyEnv, authConfigId, userId: device.userId, app }));
  }
  private appLink(device: ConnectorDevice, app: string, authConfigId: string) {
    const row = this.options.ledger.db.get<{ binding: string; state: string; result: string | null; created: number }>('SELECT binding, state, result, created FROM connector_app_links WHERE device=? AND app=?', device.id, app);
    if (row && row.binding !== this.appLinkIdentity(device, app, authConfigId)) throw new GatewayError('connector_binding_changed_needs_recovery', 409);
    return row;
  }
  /** The saved link generation is authority too: it can change without a
   * registry/policy revision. Only the digest crosses the connector boundary. */
  private mailGeneration(device: ConnectorDevice, app: 'gmail' | 'outlook', source: MailboxSource, accountId: string): string {
    const binding = app === 'gmail' ? this.binding(device, source) : this.appBinding(device, app);
    const link = app === 'gmail' ? this.link(device) : this.appLink(device, app, binding.authConfigId);
    const linkedAccount = link?.result ? (JSON.parse(link.result) as { accountId?: string }).accountId : undefined;
    return hash(canonical({ fingerprint: this.fingerprint(device, source), app, accountId, configuredAccount: binding.accountId ?? null,
      authConfigId: binding.authConfigId, userId: binding.userId, link: link ? { binding: link.binding, state: link.state, created: link.created, accountId: linkedAccount ?? null } : null,
      ...(app === 'outlook' ? { office: this.officeApp(device.companyId, app) } : {}) }));
  }
  /**
   * Admit `app` for this device's office and device, on the person's own ask.
   * Serialized per (office, app): the office's Composio-managed (or person-key) auth config is
   * found or created once in the office's own project, under the office's own
   * key; then the device's registry allowlist gains the app. Another office's
   * project, key or config is never consulted. Gmail is never re-admitted here:
   * its binding stays exactly what provisioning wrote.
   */
  private async admitApp(device: ConnectorDevice, app: string, current: () => void): Promise<void> {
    requireThat(app !== 'gmail' && APP.test(app), 'connector_app_not_admitted', 403);
    const { authConfigs, admitApp } = this.options;
    // Without admission composed, only provisioned apps exist: the old refusal.
    requireThat(authConfigs?.resolveAuthConfig && authConfigs.toolkitAuth && admitApp, 'connector_app_not_admitted', 403);
    const projectKey = this.projectKey(device);
    const company = device.companyId, now = () => this.options.ledger.now();
    await serialized(`connector-app:${company}:${app}`, async () => {
      const office = this.officeApp(company, app);
      if (office?.state === 'ready') return;
      // Composio-managed sign-in first; else a key the person types on Composio's own page.
      let keyScheme: KeyScheme | undefined;
      if (!office) {
        const auth = await authConfigs!.toolkitAuth!({ slug: app, projectKey });
        requireThat(auth, 'connector_app_unavailable', 404);
        if (auth !== 'managed') keyScheme = auth;
      }
      current();
      // A pending row is an earlier create whose outcome nobody saw: find only.
      let authConfigId: string;
      try {
        authConfigId = await authConfigs!.resolveAuthConfig!({ slug: app, projectKey, allowCreate: !office, keyScheme, beforeCreate: () => {
          this.options.ledger.db.transaction(() => {
            this.options.ledger.db.run('INSERT INTO connector_office_apps(company,app,state,created) VALUES(?,?,?,?)', company, app, 'pending', now());
            this.options.ledger.db.append(company, 'connector_app_config_requested', null, now(), { app, deviceId: device.id });
          });
        } });
      } catch (error) {
        // A definitive refusal created nothing: the intent is cleared with its
        // audit line, so the next ask may try again. Anything uncertain stays held.
        if (error instanceof GatewayError && error.code === 'connector_auth_config_rejected') {
          this.options.ledger.db.transaction(() => {
            this.options.ledger.db.run('DELETE FROM connector_office_apps WHERE company=? AND app=? AND state=?', company, app, 'pending');
            this.options.ledger.db.append(company, 'connector_app_config_rejected', null, now(), { app, deviceId: device.id });
          });
        }
        throw error;
      }
      current();
      this.options.ledger.db.transaction(() => {
        this.options.ledger.db.run('INSERT INTO connector_office_apps(company,app,state,auth_config,created) VALUES(?,?,?,?,?) ON CONFLICT(company,app) DO UPDATE SET state=excluded.state, auth_config=excluded.auth_config', company, app, 'ready', authConfigId, now());
        this.options.ledger.db.append(company, 'connector_app_config_ready', null, now(), { app, authConfigId });
      });
    });
    current();
    if (!appsOf(device).includes(app)) {
      admitApp!(device.id, app);
      this.options.ledger.db.append(company, 'connector_app_admitted', null, now(), { app, deviceId: device.id, installationId: device.installationId });
    }
  }
  private async appTools(binding: AppBinding, app: string, signal: AbortSignal): Promise<AppTool[]> {
    const key = `${hash(binding.apiKey)}:${binding.authConfigId}:${app}`, cached = this.toolCache.get(key), now = this.options.ledger.now();
    if (cached && now - cached.at < TOOL_CACHE_TTL_MS) return cached.tools;
    const tools = (await this.apps.listTools(binding, app, signal)).filter(tool => tool.policy !== 'blocked');
    // Expired listings (including rotated keys or auth configs) are released,
    // and the oldest entry goes once the cache is full.
    for (const [old, entry] of this.toolCache) if (now - entry.at >= TOOL_CACHE_TTL_MS) this.toolCache.delete(old);
    this.toolCache.delete(key);
    if (this.toolCache.size >= TOOL_CACHE_MAX) this.toolCache.delete(this.toolCache.keys().next().value!);
    this.toolCache.set(key, { at: now, tools });
    return tools;
  }
  private async appStatus(device: ConnectorDevice, app: string, signal: AbortSignal, current: () => void): Promise<{ service: ServiceStatus; binding?: AppBinding; tools: AppTool[] }> {
    if (this.officeApp(device.companyId, app)?.state !== 'ready') return { service: NOT_CONNECTED, tools: [] };
    const binding = this.appBinding(device, app);
    const accounts = await this.apps.listAccounts({ ...binding, assertAuthority: current }, app, signal); current();
    const active = accounts.filter(account => account.status === 'ACTIVE');
    // The bound account is the one this device's own sign-in created. Without
    // one recorded, exactly one active account under this private user is it.
    const account = binding.accountId ? accounts.find(row => row.id === binding.accountId) : active.length === 1 ? active[0] : undefined;
    const connected = account?.status === 'ACTIVE';
    const bound = connected ? { ...binding, accountId: account!.id } : binding;
    const tools = connected ? await this.appTools({ ...bound, assertAuthority: current }, app, signal) : [];
    current();
    return { service: { connected, status: account?.status ?? (active.length > 1 ? 'AMBIGUOUS' : 'NOT_CONNECTED'), accounts: account ? [account] : [], accountSelectionRequired: false }, binding: bound, tools };
  }
  /**
   * Ask's Gmail (owner decision 2026-10-02): the full Gmail toolkit through the
   * generic adapter, classified by the shared mailbox policy. Before any tool
   * is listed or run, the office's Gmail auth config and the bound account are
   * verified by the reviewed Gmail reader's own checks, once per session.
   * Blocked tools (permanent delete, filters, forwarding, settings) are neither
   * listed nor executable; reads and reviewed sends are forwarded as the
   * desktop dispatched them, after its per-message card.
   */
  private gmailToolkit(input: GmailReadOnlyBinding): Transport {
    const binding: AppBinding = { apiKey: input.apiKey, authConfigId: input.authConfigId, userId: input.userId,
      ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.assertAuthority ? { assertAuthority: input.assertAuthority } : {}) };
    let ready: Promise<AppTool[]> | undefined;
    const tools = (signal: AbortSignal): Promise<AppTool[]> => ready ??= (async () => {
      const access = await (this.options.access ?? getGmailReadOnlyAccess)(input);
      input.assertAuthority?.();
      const gmail = access.services.gmail;
      requireThat(Boolean(binding.accountId) && gmail?.connected === true && gmail.accounts.some(account => account.id === binding.accountId && account.status === 'ACTIVE'), 'connector_account_not_connected', 409);
      const listed = await this.appTools(binding, 'gmail', signal); input.assertAuthority?.(); return listed;
    })().catch(error => { ready = undefined; throw error; });
    const adapter = this.apps;
    return { async request(method, params, signal) {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Bud Gmail', version: '1.0.0' } };
      if (method === 'ping') return {};
      if (method === 'tools/list') return { tools: (await tools(signal)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
        annotations: { readOnlyHint: tool.policy === 'read', destructiveHint: false } })) };
      requireThat(method === 'tools/call', 'connector_method_denied', 403);
      const call = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as { name?: unknown; arguments?: unknown };
      const outside = { content: [{ type: 'text', text: 'This Gmail operation is outside the connected-app boundary: permanent delete, filters, forwarding rules and settings changes are unavailable.' }], isError: true };
      const args = call.arguments === undefined ? {} : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { content: [{ type: 'text', text: 'Tool arguments must be an object.' }], isError: true };
      // A blocked or foreign call (name and arguments) is refused before any
      // provider access, verification included. Cards are desktop-side.
      if (classifyAppToolCall(call.name, args, { app: 'gmail' }) === 'blocked') return outside;
      const tool = (await tools(signal)).find(row => row.name === call.name);
      input.assertAuthority?.();
      if (!tool) return outside;
      const result = await adapter.execute(binding, 'gmail', tool.name, args as Record<string, unknown>, signal);
      input.assertAuthority?.(); return result;
    } };
  }

  /** One MCP transport over every connected app of the device: Gmail's
   * full-toolkit transport plus one generic adapter per other connected app.
   * Tool names route by namespace; a blocked class is refused here as well as
   * on the desktop, and no tool outside an admitted, connected app is reachable. */
  private async compositeTransport(device: ConnectorDevice, assertAuthority: () => void, signal: AbortSignal, source: MailboxSource): Promise<Transport> {
    // Gmail's binding (shared-mailbox grant included) is resolved and refused
    // here, whatever other apps the device carries. A member's own mailbox gets
    // the full toolkit (owner decision 2026-10-02). An office's shared mailbox
    // stays on the three bounded reads it was granted until the owner accepts
    // the versioned full-access grant (OfficeMailbox.mailboxAccess); the grant
    // moves the policy revision and so the session fingerprint.
    const readOnly = this.officeMailbox.mailboxAccess(device.companyId, source) === 'read_only';
    const bindings: ConnectedMailBinding[] = [];
    const checks: Array<() => void> = [];
    const current = () => { assertAuthority(); for (const check of checks) check(); };
    const capture = (app: 'gmail' | 'outlook', account: AppAccount) => {
      const liveDevice = this.options.devices().find(row => row.id === device.id);
      requireThat(liveDevice, 'connector_binding_changed', 409);
      const selected = app === 'gmail' ? this.binding(liveDevice, source).accountId : this.appBinding(liveDevice, app).accountId;
      requireThat(!selected || selected === account.id, 'connector_binding_changed', 409);
      const generation = this.mailGeneration(liveDevice, app, source, account.id);
      checks.push(() => {
        // Read the current registry, saved link and configuration on every
        // boundary check, including after provider/tool-list awaits.
        const live = this.options.devices().find(row => row.id === device.id);
        requireThat(live && this.mailGeneration(live, app, source, account.id) === generation, 'connector_binding_changed', 409);
      });
      bindings.push({ provider: app, accountId: account.id, companyId: liveDevice.companyId, ...(account.label ? { label: account.label } : {}), generation });
      current(); return bindings.at(-1)!;
    };
    let gmailProfile: ((profileSignal: AbortSignal) => Promise<string | undefined>) | undefined;
    let outlookProfile: ((profileSignal: AbortSignal) => Promise<string | undefined>) | undefined;
    const gmailBinding = appsOf(device).includes('gmail') ? this.binding(device, source) : undefined;
    if (gmailBinding) {
      const generation = gmailBinding.accountId ? this.mailGeneration(device, 'gmail', source, gmailBinding.accountId) : null;
      // As before mail bindings: a failing Gmail access read only leaves Gmail
      // without a verified binding (no reviewed send), and its tools out of a
      // listing that has other apps; Outlook, Calendar and the rest continue.
      // An authority change still refuses through current().
      let access: Awaited<ReturnType<typeof getGmailReadOnlyAccess>> | undefined;
      try { access = await (this.options.access ?? getGmailReadOnlyAccess)({ ...gmailBinding, assertAuthority: current }); } catch { access = undefined; }
      current();
      if (gmailBinding.accountId) requireThat(this.mailGeneration(device, 'gmail', source, gmailBinding.accountId) === generation, 'connector_binding_changed', 409);
      const account = access?.services.gmail?.connected ? access.services.gmail.accounts.find(row => row.id === gmailBinding.accountId && row.status === 'ACTIVE') : undefined;
      if (account) {
        const captured = capture('gmail', account);
        // This is the existing fixed Gmail reader: it verifies the OAuth config,
        // selected account and GMAIL_GET_PROFILE's user_id='me' schema, projects
        // only {accountId,emailAddress,...}, and never accepts caller arguments.
        gmailProfile = async (profileSignal: AbortSignal) => {
          let result: Record<string, any>;
          try { result = await (this.options.mailProfile ?? createGmailReadOnlyTransport)({ ...gmailBinding, assertAuthority: current })
            .request('tools/call', { name: 'GMAIL_GET_PROFILE', arguments: {} }, profileSignal); }
          catch { current(); return undefined; }
          current();
          if (result.isError || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') return undefined;
          let value; try { value = JSON.parse(result.content[0].text); } catch { return undefined; }
          return value?.accountId === captured.accountId && verifiedMailAddress(value.emailAddress) ? value.emailAddress : undefined;
        };
        const address = await gmailProfile(signal); current();
        if (address) captured.emailAddress = address;
      }
    }
    const gmail = gmailBinding ? labelled((this.options.transport ?? (readOnly ? createGmailReadOnlyTransport : (binding: GmailReadOnlyBinding) => this.gmailToolkit(binding)))({ ...gmailBinding, assertAuthority: current }),
      // With both mailboxes in use, every Gmail tool says which mailbox it acts on.
      this.officeMailbox.policy(device.companyId).mode === 'both' ? (source === 'office' ? 'Office shared Gmail, not the person\'s own: use it only when they ask for the office mailbox; if unclear, ask which mailbox first. '
        : 'Your own Gmail, not the office shared mailbox. If a mail request does not say which mailbox, ask which one first. ') : '') : undefined;
    const others = new Map<string, { binding: AppBinding; tools: AppTool[] }>();
    // An office-mailbox session in `both` carries only that mailbox; the person's
    // other apps stay on their own session.
    for (const app of source === 'office' && this.officeMailbox.policy(device.companyId).mode === 'both' ? [] : appsOf(device).filter(app => app !== 'gmail')) {
      const before = app === 'outlook' ? this.appBinding(device, app).accountId : undefined;
      const generation = app === 'outlook' && before ? this.mailGeneration(device, app, source, before) : undefined;
      const status = await this.appStatus(device, app, signal, current); current();
      if (app === 'outlook' && before) requireThat(this.mailGeneration(device, app, source, before) === generation, 'connector_binding_changed', 409);
      if (status.service.connected && status.binding) others.set(app, { binding: status.binding, tools: status.tools });
      if (app === 'outlook' && status.service.connected && status.binding) {
        const captured = capture('outlook', status.service.accounts[0]!), outlookBinding = status.binding;
        // Composio's Outlook toolkit has no account-bound fixed reader like
        // Gmail's, so the generic adapter runs the read-only OUTLOOK_GET_PROFILE
        // (Microsoft Graph /me) with fixed empty arguments on this connected
        // account only. Only its primary address is kept, never caller input.
        outlookProfile = async (profileSignal: AbortSignal) => {
          let result: Record<string, unknown>;
          try { result = await this.apps.execute({ ...outlookBinding, assertAuthority: current }, 'outlook', 'OUTLOOK_GET_PROFILE', {}, profileSignal); }
          catch { current(); return undefined; }
          current();
          return outlookAddress(result);
        };
        const address = await outlookProfile(signal); current();
        if (address) captured.emailAddress = address;
      }
    }
    // Longest namespace wins, so `GOOGLE_CALENDAR_…` is not read as `GOOGLE_…`.
    const namespaces = [...others.keys()].map(app => ({ app, prefix: `${app.toUpperCase().replaceAll('-', '_')}_` })).sort((a, b) => b.prefix.length - a.prefix.length);
    const appFor = (name: string): string | undefined => namespaces.find(({ prefix }) => name.startsWith(prefix))?.app;
    const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
    const adapter = this.apps;
    return { async request(method, params, callSignal) {
      current();
      if (method === 'initialize') {
        const result = gmail ? await gmail.request(method, params, callSignal) : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Bud connected apps', version: '1.0.0' } };
        current();
        // MCP's experimental capability slot: a desktop reads it before a send;
        // the desktop broker replaces `capabilities`, so a worker never sees it.
        const capabilities = (result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {}) as Record<string, unknown>;
        const experimental = (capabilities.experimental && typeof capabilities.experimental === 'object' ? capabilities.experimental : {}) as Record<string, unknown>;
        return { ...result, capabilities: { ...capabilities, experimental: { ...experimental, [MAIL_BINDING_CAPABILITY]: { version: 1, enforcedWhenPresent: true } } },
          realbudMailBindings: parseConnectedMailBindings(bindings) };
      }
      if (method === 'ping') return {};
      if (method === 'tools/list') {
        let tools: unknown[] = [];
        if (gmail) {
          // Gmail's listing fails as it always did when no account is bound; with
          // other apps connected that only leaves Gmail's tools out of the list.
          try { const listed = (await gmail.request(method, params, callSignal)).tools; current(); tools = Array.isArray(listed) ? [...listed] : []; }
          catch (error) { if (!others.size) throw error; }
        }
        for (const { tools: appTools } of others.values()) for (const tool of appTools) tools.push({ name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
          annotations: { readOnlyHint: tool.policy === 'read', destructiveHint: false } });
        current(); return { tools };
      }
      requireThat(method === 'tools/call', 'connector_method_denied', 403);
      const call = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as { name?: unknown; arguments?: unknown; _meta?: unknown };
      requireThat(Object.keys(call).every(key => ['name', 'arguments', '_meta'].includes(key)), 'invalid_connector_call', 400);
      if (typeof call.name === 'string' && unsupportedConnectedMailTool(call.name)) return errorResult('This mail tool has no complete reviewed message/account contract. Use a supported direct mail tool.');
      const meta = call._meta && typeof call._meta === 'object' && !Array.isArray(call._meta) ? call._meta as Record<string, unknown> : undefined;
      if (typeof call.name === 'string' && MAIL_SENDS.has(call.name) && meta?.realbudReviewedMailBinding === undefined) {
        // One-release compatibility (TODO remove after 0.1.46/0.1.47 desktops
        // retire): a send with no binding metadata at all keeps the pre-binding
        // path for that call, gated by that desktop's own per-message card.
        // Any metadata present, even malformed, is enforced in full below.
        console.warn(JSON.stringify({ connectorMailSend: 'legacy_unbound', provider: call.name.startsWith('OUTLOOK_') ? 'outlook' : 'gmail' }));
      } else if (typeof call.name === 'string' && MAIL_SENDS.has(call.name)) {
        const expected = bindings.find(row => call.name!.toString().startsWith(`${row.provider.toUpperCase()}_`));
        let reviewed: ConnectedMailBinding[];
        try { reviewed = parseConnectedMailBindings([meta?.realbudReviewedMailBinding ?? null]); }
        catch { throw new GatewayError('connector_mail_review_binding_required', 409); }
        requireThat(expected && canonical(reviewed[0]) === canonical(expected), 'connector_mail_review_binding_changed', 409);
        requireThat(expected?.companyId && expected.emailAddress && connectedMailSenderArgsAllowed(call.arguments), 'connector_mail_sender_identity_required', 409);
        // Profile failure/address drift is a pre-adapter refusal; no approved
        // dispatch is sent against a different or unidentified sender.
        const currentAddress = await (expected.provider === 'gmail' ? gmailProfile : outlookProfile)?.(callSignal);
        current(); requireThat(currentAddress === expected.emailAddress, 'connector_mail_sender_identity_changed', 409);
      }
      // Internal broker authority is consumed here; no worker metadata reaches
      // an adapter, including Gmail's transport.
      const projected = { name: call.name, arguments: call.arguments };
      // Anything that is not another app's tool goes to the Gmail transport,
      // which admits only Gmail's own listed, non-blocked tools.
      const app = typeof call.name === 'string' && !call.name.startsWith('GMAIL_') ? appFor(call.name) : undefined;
      if (!app) { if (gmail) { const result = await gmail.request(method, projected, callSignal); current(); return result; } return errorResult('This tool belongs to no connected app of this office. Ask to connect the app first.'); }
      const name = call.name as string;
      const { binding, tools } = others.get(app)!;
      const tool = tools.find(row => row.name === name);
      if (!tool) return errorResult('This tool is outside the connected-app boundary: destructive, bulk and administrative operations are unavailable.');
      const args = call.arguments === undefined ? {} : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return errorResult('Tool arguments must be an object.');
      const result = await adapter.execute({ ...binding, assertAuthority: current }, app, name, args as Record<string, unknown>, callSignal);
      current();
      return result;
    } };
  }

  async handle(input: { token: string; profile: string; method: string; path: string; body?: unknown; session?: string; policyRevision?: number; mailbox?: MailboxSource; signal: AbortSignal }): Promise<ConnectorResponse> {
    let device = this.current(input.token, input.profile); const now = this.options.ledger.now();
    const policy=this.officeMailbox.policy(device.companyId);
    if (!['/v1/connectors/status', '/v1/connectors/authorize', '/v1/connectors/events'].includes(input.path)) {
      requireThat((policy.mode === 'personal' && policy.revision === 0 && input.policyRevision === undefined) || input.policyRevision === policy.revision, 'office_mailbox_review_required', 409);
    }
    // Which mailbox this request uses. In `both` the office mailbox is chosen only
    // by an explicit selection (MCP) or its exact confirmed account (saved
    // workflows); `binding` still requires this computer's grant.
    const named = input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>)[input.path === '/v1/connectors/mail-scan' ? 'expectedAccountId' : 'accountId'] : undefined;
    const source = this.officeMailbox.source(device.companyId, input.mailbox ??
      (['/v1/connectors/mail-scan', '/v1/connectors/mail-attachment'].includes(input.path) && this.officeMailbox.isOfficeAccount(device.companyId, named) ? 'office' : undefined));
    // Only bounded read/connection operations are admitted. No caller may choose
    // the upstream URL, project key, provider user or connected account.
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, rate] of this.rates) if (rate.starts + 60_000 <= now) this.rates.delete(key);
    const rate = this.rates.get(device.id) ?? { starts: now, count: 0 };
    requireThat(rate.count < 120, 'connector_rate_limited', 429); rate.count++; this.rates.set(device.id, rate);
    // The event pull is a local read: it never waits on another request of this device.
    if (input.path === '/v1/connectors/events' && input.method === 'POST') return { status: 200, body: this.triggers.pull(device, input.body) };
    requireThat(!this.inflight.has(device.id), 'connector_busy', 409); this.inflight.add(device.id);
    let fingerprint = this.fingerprint(device, source);
    const current = () => { input.signal.throwIfAborted(); requireThat(this.fingerprint(this.current(input.token, input.profile), source) === fingerprint, 'connector_binding_changed', 409); };
    try {
      if (input.path === '/v1/connectors/mail-attachment' && input.method === 'POST') {
        const attachment=parseSourceAttachmentRequest(input.body),mailbox=source;this.admit(device,'gmail');
        const binding=this.binding(device,mailbox);
        const assertAuthority=()=>{current();requireThat(this.binding(this.current(input.token,input.profile),mailbox).accountId===attachment.accountId,'mail_attachment_account_binding_changed',409);};
        requireThat(binding.accountId===attachment.accountId,'mail_attachment_account_binding_changed',409);assertAuthority();
        const result=await(this.options.attachment??readGmailPdfAttachment)({...binding,assertAuthority},attachment,input.signal);
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
        const binding = this.binding(device, source);
        const assertScanAuthority = () => {
          current();
          // Include account selection restored from connector_links, which can
          // change independently of the device registry fingerprint.
          requireThat(this.binding(this.current(input.token, input.profile), source).accountId === expectedAccountId, 'mail_scan_account_binding_changed', 409);
        };
        requireThat(binding.accountId === expectedAccountId, 'mail_scan_account_binding_changed', 409);
        assertScanAuthority();
        const result = await (this.options.scan ?? scanGmailReadOnly)({ ...binding, assertAuthority: assertScanAuthority }, request, input.signal);
        assertScanAuthority(); return { status: 200, body: result };
      }
      if (input.path === '/v1/connectors/triggers' && input.method === 'POST') {
        object(input.body); exact(input.body, ['app', 'event', 'enabled']);
        const spec = triggerSpec(input.body.app, input.body.event), enabled = input.body.enabled;
        requireThat(typeof enabled === 'boolean', 'invalid_fields');
        this.admit(device, spec.app);
        // The gateway's own binding: the caller names no account, provider user or project.
        const binding = { ...this.binding(device, source), assertAuthority: current };
        if (enabled) {
          const access = await (this.options.access ?? getGmailReadOnlyAccess)(binding); current();
          requireThat(binding.accountId && access.services.gmail?.accounts.some(account => account.id === binding.accountId && account.status === 'ACTIVE'), 'connector_account_not_connected', 409);
        }
        return { status: 200, body: await this.triggers.set(device, binding, spec, enabled as boolean, input.signal) };
      }
      if (input.path === '/v1/connectors/status' && input.method === 'GET') {
        const services: Record<string, ServiceStatus> = {}; const names: string[] = []; let officeShared: ServiceStatus | undefined;
        if (appsOf(device).includes('gmail')) {
          const policy = this.officeMailbox.policy(device.companyId);
          const result = policy.mode === 'shared' && !this.officeMailbox.readyForDevice(device)
            ? { services: { gmail: NOT_CONNECTED }, tools: { available: false, names: [] as string[] } }
            : await (this.options.access ?? getGmailReadOnlyAccess)({ ...this.binding(device, source), assertAuthority: current });
          current();
          services.gmail = { ...result.services.gmail!, accountSelectionRequired: false } as ServiceStatus; names.push(...result.tools.names);
          if (policy.mode === 'both') {
            // The office mailbox, beside the person's own: only on a granted
            // computer is it read; otherwise it is plainly not connected.
            const office = this.officeMailbox.readyForDevice(device)
              ? (await (this.options.access ?? getGmailReadOnlyAccess)({ ...this.binding(device, 'office'), assertAuthority: current })).services.gmail ?? NOT_CONNECTED
              : NOT_CONNECTED;
            current();
            // The label is the office's confirmed address, never a provider alias: approval cards name it.
            const address = this.officeMailbox.confirmedAddress(device.companyId);
            officeShared = { ...office, accounts: office.accounts.map(account => { const { label: _alias, ...rest } = account; return address ? { ...rest, label: address } : rest; }), accountSelectionRequired: false } as ServiceStatus;
          }
        }
        for (const app of appsOf(device).filter(app => app !== 'gmail')) {
          const status = await this.appStatus(device, app, input.signal, current);
          services[app] = status.service; names.push(...status.tools.map(tool => tool.name));
        }
        current();
        return { status: 200, body: { checkedAt: new Date(now).toISOString(), services, tools: { available: names.length > 0, names },
          // `sourceKind` names the default mailbox (an older desktop reads `both` as personal);
          // `mailboxMode` and `officeShared` add the office mailbox beside it.
          sourceKind: policy.mode === 'shared' ? 'office_shared' : 'personal', policyRevision: policy.revision, managed: true, mailboxMode: policy.mode,
          ...(officeShared ? { officeShared, officeMailboxAccess: this.officeMailbox.mailboxAccess(device.companyId, 'office') } : {}),
          // Lets the desktop say "the owner must enable this" instead of showing a send card the gateway would refuse.
          ...(appsOf(device).includes('gmail') ? { mailboxAccess: this.officeMailbox.mailboxAccess(device.companyId) } : {}), apps: appsOf(device), serviceExpiresAt: this.options.ledger.tenant(device.companyId).serviceExpiresAt,
          // Event triggers this computer reads, with `expired` / `provider_disabled` when Composio said so.
          triggers: this.triggers.status(device) } };
      }
      if (input.path === '/v1/connectors/authorize' && input.method === 'POST') {
        object(input.body); exact(input.body, ['app']);
        requireThat(typeof input.body.app === 'string' && APP.test(input.body.app), 'connector_app_not_admitted', 403);
        const app = input.body.app as string;
        if (app !== 'gmail') {
          // Any other toolkit: admit it into this office's project on demand, then link.
          if (!appsOf(device).includes(app) || this.officeApp(device.companyId, app)?.state !== 'ready') {
            await this.admitApp(device, app, current);
            device = this.current(input.token, input.profile);
          }
          this.admit(device, app);
          const binding = this.appBinding(device, app);
          const existing = this.appLink(device, app, binding.authConfigId);
          let replacing = false;
          if (existing) {
            requireThat(existing.state === 'ready' && existing.result, 'connector_link_outcome_unknown', 409);
            const result = JSON.parse(existing.result) as { url: string; accountId?: string; expiresAt: string };
            if (Date.parse(result.expiresAt) > now) return { status: 200, body: { url: result.url } };
            // A lapsed link is replaced only once the provider says its account never connected.
            const accounts = await this.apps.listAccounts({ ...binding, assertAuthority: current }, app, input.signal); current();
            requireThat(!accounts.some(account => account.id === result.accountId && account.status === 'ACTIVE'), 'connector_account_already_bound', 409);
            replacing = true;
          }
          const identity = this.appLinkIdentity(device, app, binding.authConfigId);
          this.options.ledger.db.transaction(() => {
            if (replacing) this.options.ledger.db.run('UPDATE connector_app_links SET state=?,result=NULL,created=? WHERE device=? AND app=?', 'unknown', now, device.id, app);
            else this.options.ledger.db.run('INSERT INTO connector_app_links(device,app,binding,state,created) VALUES(?,?,?,?,?)', device.id, app, identity, 'unknown', now);
            this.options.ledger.db.append(device.companyId, replacing ? 'connector_link_replaced' : 'connector_link_requested', null, now, { deviceId: device.id, app });
          });
          let result: Awaited<ReturnType<ComposioAppAdapter['authorize']>>;
          try { result = await this.apps.authorize({ ...binding, accountId: undefined, assertAuthority: current }, input.signal); }
          catch (error) {
            // A definitive refusal (not a timeout, not rate limiting) created no
            // link: the row is cleared so the next ask starts clean. Anything
            // uncertain stays `unknown` for reconciliation.
            const status = (error as { status?: unknown } | null)?.status;
            if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
              this.options.ledger.db.transaction(() => {
                this.options.ledger.db.run('DELETE FROM connector_app_links WHERE device=? AND app=? AND state=?', device.id, app, 'unknown');
                this.options.ledger.db.append(device.companyId, 'connector_link_rejected', null, now, { deviceId: device.id, app });
              });
              throw new GatewayError('connector_link_rejected', 502);
            }
            throw error;
          }
          this.options.ledger.db.run('UPDATE connector_app_links SET state=?,result=? WHERE device=? AND app=?', 'ready', JSON.stringify(result), device.id, app);
          current(); return { status: 200, body: { url: result.url } };
        }
        // Only a shared-only office refuses a person's own Gmail; `both` allows it.
        requireThat(this.officeMailbox.policy(device.companyId).mode !== 'shared', 'office_mailbox_owner_authorization_required', 403);
        this.admit(device, app);
        // A device still on a Gmail config nobody could connect moves to the
        // office's current one before any link is read or issued.
        if (await this.rebindGmail(device, current)) {
          device = this.current(input.token, input.profile);
          fingerprint = this.fingerprint(device, source);
          this.admit(device, app);
        }
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
      if (message.method === 'realbud/mail-binding') {
        // Owner recovery checks are read-only and do not consume a retained
        // MCP session. This capability is never mounted in the worker broker.
        requireThat(!input.session && message.params === undefined, 'invalid_connector_rpc', 400);
        const transport = await this.compositeTransport(device, current, input.signal, source); current();
        const result = await transport.request('initialize', undefined, input.signal); current();
        return { status: 200, body: { jsonrpc: '2.0', id: message.id, result: { realbudMailBindings: result.realbudMailBindings } } };
      }
      if (message.method === 'initialize') {
        // Gmail's admitted read-only method list is unchanged; other connected
        // apps add their classified tools under their own namespaces.
        requireThat(appsOf(device).length > 0, 'connector_app_not_admitted', 403);
        requireThat(!input.session && this.sessions.size < 128 && [...this.sessions.values()].filter(item => item.device === device.id).length < 8, 'connector_session_limit', 429);
        // Do not capture this HTTP request's abort signal in a multi-request
        // session. Revalidate the live device/tenant before each adapter request.
        const assertAuthority = () => {
          requireThat(this.fingerprint(this.current(input.token, input.profile), source) === fingerprint, 'connector_binding_changed', 409);
        };
        const transport = await this.compositeTransport(device, assertAuthority, input.signal, source);
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
        // The adapters return only projected results. No sessions, provider
        // credentials or arbitrary upstream headers are reflected to clients.
        return { status: 200, session: input.session, body: { jsonrpc: '2.0', id: message.id, result } };
      } finally { session.busy = false; }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('connector_check_failed', 502);
    } finally { this.inflight.delete(device.id); }
  }
}
