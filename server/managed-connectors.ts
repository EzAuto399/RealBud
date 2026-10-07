import { createHash } from 'node:crypto';
import type { ConnectedAppsStatus } from '../shared/office-sources.ts';
import type { AppConfig } from './config.ts';
import { currentWorkerProfile } from './hermes-profile.ts';
import { parseMailScanResult, type MailScanRequest } from '../shared/mail-ingestion.ts';
import { managedConnectorApps } from './worker-model-access.ts';
import { classifyAppTool, type MailboxAccess } from '../shared/app-tool-policy.ts';
import { ConnectionAuthorizationError, managedAuthorizationFailure } from './connection-outcome.ts';
/** Re-exported so callers of the managed connector surface do not need to know
 * where the installation's provisioning record lives. */
export { managedConnectorApps };

import { parseSourceAttachmentRequest, type SourceAttachmentRequest } from '../shared/source-attachments.ts';
import { validateSourceAttachmentBytes } from './source-attachments.ts';
type Service = {connected: boolean; status: string; accounts: {id: string;label?:string;status:string}[];accountSelectionRequired:boolean};
type Status = { sourceKind?: 'personal' | 'office_shared'; policyRevision?: number; checkedAt: string; managed: true; serviceExpiresAt: number;
  /** `both`: `services.gmail` is the person's own mailbox and `officeShared` the office one beside it. */
  mailboxMode?: 'personal' | 'shared' | 'both'; officeShared?: Service;
  services: Record<string, Service>;
  tools: {available:boolean;names:string[]} };

export const managedConnectorConfigured = (cfg: AppConfig): boolean => cfg.composio?.managed !== undefined;
/** The last checked Gmail scope per managed credential (by hash; the credential
 * itself is never kept here). The Ask broker reads it so it never shows a send
 * card for a shared mailbox the gateway holds to the three reads. Unknown means
 * no status was read yet: the gateway still enforces. */
const mailboxAccessByCredential = new Map<string, MailboxAccess>();
const credentialKey = (credential: string) => createHash('sha256').update(credential).digest('hex');
/** The office mailbox's scope is kept under its own key: in `both` it differs from the person's own. */
export const managedMailboxAccess = (credential: string, mailbox: 'personal' | 'office' = 'personal'): MailboxAccess | undefined => mailboxAccessByCredential.get(credentialKey(credential) + (mailbox === 'office' ? ':office' : ''));
/** `mailbox: 'office'` selects the office shared mailbox for this session; the gateway still checks this computer's grant. */
export function managedConnectorSettings(cfg: AppConfig, expectedPolicyRevision?: number, mailbox?: 'office'): {key:string;url:string;headers:Record<string,string>} {
  if (expectedPolicyRevision !== undefined && (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0)) throw new Error('The reviewed mail policy needs checking.');
  const managed = cfg.composio?.managed;
  const fail = (): never => { throw Object.assign(new Error('Managed connections need service setup for this private workspace.'), {status:403}); };
  if (!managed || Object.keys(managed).sort().join(',') !== 'credential,endpoint,profile' ||
    typeof managed.credential !== 'string' || !/^rbc_[a-f0-9]{64}$/.test(managed.credential) ||
    managed.profile !== currentWorkerProfile().profile || typeof managed.endpoint !== 'string' || managed.endpoint.length > 2048) return fail();
  let url: URL; try { url = new URL(managed.endpoint); } catch { return fail(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)))) return fail();
  return {key:managed.credential,url:`${url.origin}/v1/connectors/mcp`,headers:{authorization:`Bearer ${managed.credential}`,'x-realbud-profile':managed.profile,...(expectedPolicyRevision === undefined ? {} : {'x-realbud-policy-revision':String(expectedPolicyRevision)}),...(mailbox === 'office' ? {'x-realbud-mailbox':'office'} : {})}};
}
async function request(cfg: AppConfig, path: string, body?: unknown, inputSignal?: AbortSignal, expectedPolicyRevision?: number): Promise<unknown> {
  if (expectedPolicyRevision !== undefined && (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0)) throw new Error('The reviewed mail policy needs checking.');
  const settings=managedConnectorSettings(cfg), signal=AbortSignal.any([AbortSignal.timeout(path === '/v1/connectors/mail-scan' ? 250_000 : 35_000), ...(inputSignal ? [inputSignal] : [])]);
  const response=await fetch(new URL(path,settings.url), {method:body===undefined?'GET':'POST',redirect:'error',signal,
    headers:{...settings.headers,...(expectedPolicyRevision === undefined ? {} : {'x-realbud-policy-revision': String(expectedPolicyRevision)}),accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if (!response.ok || response.redirected) {
    if (path === '/v1/connectors/authorize') {
      if (response.redirected) await response.body?.cancel().catch(() => {});
      throw managedAuthorizationFailure(response.status, response.redirected ? undefined : await authorizationFailureCode(response));
    }
    await response.body?.cancel().catch(()=>{});
    const message=response.status===402?'Your managed service is paused or expired. Contact service support.':
      response.status===403?'Managed connection access was revoked or changed. Contact service support.':
      response.status===404&&path==='/v1/connectors/authorize'?'That app is not available to connect. Check the app’s name, or ask service support whether it can be added.':
      response.status===409&&['/v1/connectors/mail-scan','/v1/connectors/mail-attachment'].includes(path)?'The Gmail connection changed. Review the connected account and approve the mail source again before scanning.':
      response.status===400&&path==='/v1/connectors/mail-scan'?'This mail scan needs a reviewed Gmail account and a compatible managed service. Update RealBud and ask service support to check the connection.':
      response.status===409?'This connection needs recovery. Check its current result with service support before trying again.':'Managed connections could not be checked. Try again when the service is available.';
    throw Object.assign(new Error(message), {status:response.status>=400&&response.status<500?response.status:502});
  }
  if (!response.body) throw new Error('The managed connection response was incomplete.');
  const reader=response.body.getReader(); let size=0;const chunks:Uint8Array[]=[];
  try { for (;;) { const {value,done}=await reader.read(); if(done)break;size+=value.length;if(size>(path==='/v1/connectors/mail-attachment'?2_800_000:1_000_000))throw new Error('The managed connection response was too large.');chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The managed connection response was incomplete.'); }
}
/** Read only the gateway's bounded error-code envelope. Do not retain or show
 * upstream diagnostics, credentials, account payloads or error-body links. */
async function authorizationFailureCode(response: Response): Promise<string | undefined> {
  if (!response.body) return;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 4096) return;
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'error') {
      const code = (value as { error?: unknown }).error;
      if (typeof code === 'string' && /^[a-z_]{1,100}$/.test(code)) return code;
    }
  } catch { /* An unreadable error is an unknown outcome, not a refusal. */ }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function scanManagedMail(cfg: AppConfig, accountId: string, scope: MailScanRequest, signal: AbortSignal, expectedPolicyRevision?: number) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw Object.assign(new Error('Review and select the Gmail account before scanning mail.'), { status: 400 });
  // This is a precondition on the gateway-owned source, never an account override.
  return parseMailScanResult(await request(cfg, '/v1/connectors/mail-scan', { expectedAccountId: accountId, scope }, signal, expectedPolicyRevision), scope, accountId);
}
export async function readManagedMailAttachment(cfg: AppConfig, source: SourceAttachmentRequest, signal: AbortSignal, expectedPolicyRevision?: number) {
  const selected = parseSourceAttachmentRequest(source);
  return validateSourceAttachmentBytes(await request(cfg,'/v1/connectors/mail-attachment',selected,signal,expectedPolicyRevision),selected);
}
export async function managedConnectorAccess(cfg: AppConfig): Promise<Status> {
  const value = await request(cfg, '/v1/connectors/status');
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  const status = (input: unknown): input is string => typeof input === 'string' && /^[A-Z_]{1,40}$/.test(input);
  const invalid = (): never => { throw new Error('The managed connection response needs review.'); };
  // The admitted apps are the gateway's `apps` list for this installation's own
  // credential: the office admits apps there, one at a time, on the person's
  // "connect <app>". The apps recorded at link time are the floor, so a
  // response can never drop Gmail from an installation provisioned with it.
  const linked = await managedConnectorApps();
  const granted = admittedApps(value, linked);
  if (!granted) return invalid();
  if (!record(value) || value.managed !== true || !Number.isSafeInteger(value.serviceExpiresAt) || Number(value.serviceExpiresAt) < 0 ||
    typeof value.checkedAt !== 'string' || value.checkedAt.length > 40 || !Number.isFinite(Date.parse(value.checkedAt)) ||
    !record(value.services) || Object.keys(value.services).some(key => !granted.includes(key)) ||
    !record(value.tools)) return invalid();
  if (value.mailboxAccess !== undefined && value.mailboxAccess !== 'full' && value.mailboxAccess !== 'read_only') return invalid();
  if ((value.sourceKind !== undefined || value.policyRevision !== undefined) &&
    (!['personal', 'office_shared'].includes(String(value.sourceKind)) || !Number.isSafeInteger(value.policyRevision) || Number(value.policyRevision) < 0)) return invalid();
  const tools = value.tools;
  if (typeof tools.available !== 'boolean' || !Array.isArray(tools.names) || tools.names.length > MAX_TOOLS_PER_APP * granted.length ||
    new Set(tools.names).size !== tools.names.length || tools.names.some(name => !toolNameAllowed(name, granted))) return invalid();
  if (value.mailboxMode !== undefined && !['personal', 'shared', 'both'].includes(String(value.mailboxMode))) return invalid();
  if (value.officeMailboxAccess !== undefined && value.officeMailboxAccess !== 'full' && value.officeMailboxAccess !== 'read_only') return invalid();
  const service = (input: unknown): Service => {
  if (!record(input) || typeof input.connected !== 'boolean' || !status(input.status) || input.accountSelectionRequired !== false ||
    !Array.isArray(input.accounts) || input.accounts.length > 1) return invalid();
  const accounts = input.accounts.map((account: unknown) => {
    if (!record(account) || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || !status(account.status) ||
      (account.label !== undefined && (typeof account.label !== 'string' || account.label.length > 200 || /[\u0000-\u001f\u007f]/.test(account.label)))) return invalid();
    return { id: account.id, status: account.status, ...(typeof account.label === 'string' ? { label: account.label } : {}) };
  });
  if (input.connected !== (accounts[0]?.status === 'ACTIVE') || (input.connected && input.status !== 'ACTIVE')) return invalid();
  // Project every level. A new gateway diagnostic or credential field must not
  // silently become part of the desktop's cached status or renderer response.
  return { connected: input.connected, status: input.status, accounts, accountSelectionRequired: false };
  };
  const services: Status['services'] = {};
  let anyConnected = false;
  for (const [slug, input] of Object.entries(value.services)) { services[slug] = service(input); anyConnected ||= services[slug].connected; }
  // The office mailbox beside the person's own exists only in `both`, only with Gmail admitted.
  if (value.officeShared !== undefined && (value.mailboxMode !== 'both' || !granted.includes('gmail'))) return invalid();
  const officeShared = value.officeShared === undefined ? undefined : service(value.officeShared);
  // Tools exist only for a connected app; a connected app may still expose none.
  if (tools.available !== (tools.names.length > 0) || (tools.names.length > 0 && !anyConnected)) return invalid();
  // A shared office mailbox without a reported grant is read-only; an older
  // gateway that reports nothing leaves a personal mailbox's scope unknown.
  const credential = managedConnectorSettings(cfg).key;
  const access: MailboxAccess | undefined = value.mailboxAccess === 'full' || value.mailboxAccess === 'read_only' ? value.mailboxAccess
    : value.sourceKind === 'office_shared' ? 'read_only' : undefined;
  if (access) mailboxAccessByCredential.set(credentialKey(credential), access); else mailboxAccessByCredential.delete(credentialKey(credential));
  // An office mailbox without a reported grant is read-only.
  if (officeShared) mailboxAccessByCredential.set(credentialKey(credential) + ':office', value.officeMailboxAccess === 'full' ? 'full' : 'read_only');
  else mailboxAccessByCredential.delete(credentialKey(credential) + ':office');
  return {
    checkedAt: new Date(value.checkedAt).toISOString(), managed: true, serviceExpiresAt: Number(value.serviceExpiresAt),
    ...(value.sourceKind !== undefined ? { sourceKind: value.sourceKind as 'personal' | 'office_shared', policyRevision: Number(value.policyRevision) } : {}),
    ...(value.mailboxMode !== undefined ? { mailboxMode: value.mailboxMode as 'personal' | 'shared' | 'both' } : {}),
    ...(officeShared ? { officeShared } : {}),
    services, tools: { available: tools.available, names: [...tools.names] as string[] },
  };
}
const MAX_TOOLS_PER_APP = 400;
const APP_SLUG = /^[a-z][a-z0-9_]{0,31}$/;
/** The gateway's admitted-app list for this credential, checked for shape and
 * for holding every app this installation was linked with. */
function admittedApps(value: unknown, linked: string[]): string[] | undefined {
  const apps = (value as { apps?: unknown } | null)?.apps;
  if (apps === undefined) return linked;
  if (!Array.isArray(apps) || apps.length > 64 || new Set(apps).size !== apps.length || apps.some(app => typeof app !== 'string' || !APP_SLUG.test(app))) return undefined;
  return linked.every(app => apps.includes(app)) ? apps as string[] : undefined;
}
/** Gmail keeps its exact reviewed read-only triple. Another admitted app may
 * expose only tools under its own namespace whose class is read or review —
 * a destructive, bulk or administrative name is refused here as on the gateway. */
function toolNameAllowed(name: unknown, granted: string[]): boolean {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) return false;
  if (name.startsWith('GMAIL_')) return granted.includes('gmail') && ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'].includes(name);
  return granted.some(app => app !== 'gmail' && classifyAppTool(name, { app }) !== 'blocked');
}
/** Any Composio toolkit: the gateway admits it into this office's own project
 * on demand, or refuses. Gmail follows its own reviewed path there. */
export async function authorizeManagedConnection(cfg: AppConfig, app: string): Promise<{url:string}> {
  if(typeof app!=='string'||!APP_SLUG.test(app))throw new ConnectionAuthorizationError('not-started', 'invalid-app', 400);
  try { managedConnectorSettings(cfg); }
  catch { throw new ConnectionAuthorizationError('not-started', 'setup', 403); }
  try {
    const value=await request(cfg,'/v1/connectors/authorize',{app}) as {url?:unknown};
    if(typeof value?.url!=='string' || value.url.length>4096)throw new ConnectionAuthorizationError('unknown', 'unknown');
    const url=new URL(value.url);
    if(url.protocol!=='https:' || url.username || url.password || url.port || !(url.hostname==='composio.dev'||url.hostname.endsWith('.composio.dev')))throw new ConnectionAuthorizationError('unknown', 'unknown');
    return {url:value.url};
  } catch (error) {
    if (error instanceof ConnectionAuthorizationError) throw error;
    throw new ConnectionAuthorizationError('unknown', 'unknown');
  }
}

/** A provider account can stay the same while its office grant changes. */
export function managedMailBindingRevision(workspace: string, profile: string, connection: AppConfig['composio'], access: Pick<ConnectedAppsStatus, 'services' | 'sourceKind' | 'policyRevision'>): string {
  return createHash('sha256').update(JSON.stringify({ workspace, profile, connection,
    source: { accountId: access.services.gmail?.accounts[0]?.id ?? null, sourceKind: access.sourceKind ?? null, policyRevision: access.policyRevision ?? null },
  })).digest('hex');
}
