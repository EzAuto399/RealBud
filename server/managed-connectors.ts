import type { AppConfig } from './config.ts';
import { currentWorkerProfile } from './hermes-profile.ts';
import { parseMailScanResult, type MailScanRequest } from '../shared/mail-ingestion.ts';
import { managedConnectorApps } from './worker-model-access.ts';
/** Re-exported so callers of the managed connector surface do not need to know
 * where the installation's provisioning record lives. */
export { managedConnectorApps };

export interface ManagedConnectorConfig { endpoint: string; credential: string; profile: string }
import { parseSourceAttachmentRequest, type SourceAttachmentRequest } from '../shared/source-attachments.ts';
import { validateSourceAttachmentBytes } from './source-attachments.ts';
type Status = { checkedAt: string; managed: true; serviceExpiresAt: number;
  services: Record<string, {connected: boolean; status: string; accounts: {id: string;label?:string;status:string}[];accountSelectionRequired:boolean}>;
  tools: {available:boolean;names:string[]} };

export const managedConnectorConfigured = (cfg: AppConfig): boolean => cfg.composio?.managed !== undefined;
export function managedConnectorSettings(cfg: AppConfig): {key:string;url:string;headers:Record<string,string>} {
  const managed = cfg.composio?.managed;
  const fail = (): never => { throw Object.assign(new Error('Managed connections need service setup for this private workspace.'), {status:403}); };
  if (!managed || Object.keys(managed).sort().join(',') !== 'credential,endpoint,profile' ||
    typeof managed.credential !== 'string' || !/^rbc_[a-f0-9]{64}$/.test(managed.credential) ||
    managed.profile !== currentWorkerProfile().profile || typeof managed.endpoint !== 'string' || managed.endpoint.length > 2048) return fail();
  let url: URL; try { url = new URL(managed.endpoint); } catch { return fail(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)))) return fail();
  return {key:managed.credential,url:`${url.origin}/v1/connectors/mcp`,headers:{authorization:`Bearer ${managed.credential}`,'x-realbud-profile':managed.profile}};
}
async function request(cfg: AppConfig, path: string, body?: unknown, inputSignal?: AbortSignal): Promise<unknown> {
  const settings=managedConnectorSettings(cfg), signal=AbortSignal.any([AbortSignal.timeout(path === '/v1/connectors/mail-scan' ? 250_000 : 35_000), ...(inputSignal ? [inputSignal] : [])]);
  const response=await fetch(new URL(path,settings.url), {method:body===undefined?'GET':'POST',redirect:'error',signal,
    headers:{...settings.headers,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(()=>{});
    const message=response.status===402?'Your managed service is paused or expired. Contact service support.':
      response.status===403?'Managed connection access was revoked or changed. Contact service support.':
      response.status===409&&path==='/v1/connectors/mail-scan'?'The Gmail connection changed. Review the connected account and approve the mail source again before scanning.':
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
export async function scanManagedMail(cfg: AppConfig, accountId: string, scope: MailScanRequest, signal: AbortSignal) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw Object.assign(new Error('Review and select the Gmail account before scanning mail.'), { status: 400 });
  // This is a precondition on the gateway-owned source, never an account override.
  return parseMailScanResult(await request(cfg, '/v1/connectors/mail-scan', { expectedAccountId: accountId, scope }, signal), scope, accountId);
}
export async function readManagedMailAttachment(cfg: AppConfig, source: SourceAttachmentRequest, signal: AbortSignal) {
  const selected = parseSourceAttachmentRequest(source);
  return validateSourceAttachmentBytes(await request(cfg,'/v1/connectors/mail-attachment',selected,signal),selected);
}
export async function managedConnectorAccess(cfg: AppConfig): Promise<Status> {
  const value = await request(cfg, '/v1/connectors/status');
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  const status = (input: unknown): input is string => typeof input === 'string' && /^[A-Z_]{1,40}$/.test(input);
  const invalid = (): never => { throw new Error('The managed connection response needs review.'); };
  // The granted apps come from this installation's own provisioning record,
  // never from the response: a broker cannot widen its own allowlist.
  const granted = await managedConnectorApps();
  if (!record(value) || value.managed !== true || !Number.isSafeInteger(value.serviceExpiresAt) || Number(value.serviceExpiresAt) < 0 ||
    typeof value.checkedAt !== 'string' || value.checkedAt.length > 40 || !Number.isFinite(Date.parse(value.checkedAt)) ||
    !record(value.services) || !Object.keys(value.services).length || Object.keys(value.services).some(key => !granted.includes(key)) ||
    !record(value.tools)) return invalid();
  const tools = value.tools;
  if (typeof tools.available !== 'boolean' || !Array.isArray(tools.names) || tools.names.length > 8 * granted.length ||
    new Set(tools.names).size !== tools.names.length || tools.names.some(name => !toolNameAllowed(name, granted))) return invalid();
  const services: Status['services'] = {};
  let anyConnected = false;
  for (const [slug, input] of Object.entries(value.services)) {
  if (!record(input) || typeof input.connected !== 'boolean' || !status(input.status) || input.accountSelectionRequired !== false ||
    !Array.isArray(input.accounts) || input.accounts.length > 1) return invalid();
  const accounts = input.accounts.map((account: unknown) => {
    if (!record(account) || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || !status(account.status) ||
      (account.label !== undefined && (typeof account.label !== 'string' || account.label.length > 200 || /[\u0000-\u001f\u007f]/.test(account.label)))) return invalid();
    return { id: account.id, status: account.status, ...(typeof account.label === 'string' ? { label: account.label } : {}) };
  });
  if (input.connected !== (accounts[0]?.status === 'ACTIVE') || (input.connected && input.status !== 'ACTIVE')) return invalid();
  anyConnected ||= input.connected;
  // Project every level. A new gateway diagnostic or credential field must not
  // silently become part of the desktop's cached status or renderer response.
  services[slug] = { connected: input.connected, status: input.status, accounts, accountSelectionRequired: false };
  }
  if (tools.available !== anyConnected || (anyConnected ? tools.names.length === 0 : tools.names.length !== 0)) return invalid();
  return {
    checkedAt: new Date(value.checkedAt).toISOString(), managed: true, serviceExpiresAt: Number(value.serviceExpiresAt),
    services, tools: { available: tools.available, names: [...tools.names] as string[] },
  };
}
/** Gmail keeps its exact reviewed read-only triple. Another granted app may
 * expose whatever the broker allows under that app's own tool namespace — this
 * admits no tool the broker did not already return, and no cross-app name. */
function toolNameAllowed(name: unknown, granted: string[]): boolean {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return false;
  if (name.startsWith('GMAIL_')) return ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'].includes(name);
  return granted.some(app => app !== 'gmail' && name.startsWith(`${app.toUpperCase().replaceAll('-', '_')}_`));
}
export async function authorizeManagedConnection(cfg: AppConfig, app: string): Promise<{url:string}> {
  if(!(await managedConnectorApps()).includes(app))throw Object.assign(new Error('This managed connection is not part of this computer’s service setup.'),{status:403});
  const value=await request(cfg,'/v1/connectors/authorize',{app}) as {url?:unknown};
  if(typeof value?.url!=='string' || value.url.length>4096)throw new Error('The managed sign-in response needs review.');
  const url=new URL(value.url);
  if(url.protocol!=='https:' || url.username || url.password || url.port || !(url.hostname==='composio.dev'||url.hostname.endsWith('.composio.dev')))throw new Error('The managed sign-in link needs review.');
  return {url:value.url};
}
