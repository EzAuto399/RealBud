/** Gateway-owned office policy. Shared Gmail remains a PRIVATE provider account;
 * only these credential-bound grants allow a desktop to use it. */
import { createHash } from 'node:crypto';
import { GatewayError, canonical, exact, object, requireThat, type PortalPrincipal } from './contracts.ts';
import type { ConnectorDevice, ConnectorOptions } from './connectors.ts';
import { authorizeGmailReadOnly, getGmailReadOnlyAccess, createGmailReadOnlyTransport, type GmailReadOnlyBinding } from '../server/composio-gmail.ts';
import { FULL_MAILBOX_ACCESS_VERSION, FULL_MAILBOX_ACCESS_WORDING } from '../shared/app-tool-policy.ts';
/** The owner's versioned full-access grant on the shared mailbox: who accepted
 * the exact wording, and when. Absent means the three bounded reads. */
interface FullAccess { version: typeof FULL_MAILBOX_ACCESS_VERSION; grantedBy: string; grantedAt: string }
/** `personal`: each person connects their own Gmail. `shared`: one owner-connected
 * office mailbox, used by granted computers only. `both`: each person's own Gmail,
 * and granted computers may also use the office mailbox when a request selects it. */
export type MailboxMode = 'personal'|'shared'|'both';
/** Which mailbox one request uses. A personal connection never becomes office-wide. */
export type MailboxSource = 'personal'|'office';
const MODES:readonly MailboxMode[]=['personal','shared','both'];
/** Modes in which the office mailbox exists (owner setup, grants, full access). */
export const officeMode=(mode:MailboxMode)=>mode==='shared'||mode==='both';
interface Policy { mode: MailboxMode; revision: number; grants: string[]; fullMailboxAccess?: FullAccess }
interface Mailbox { projectKeyEnv: string; authConfigId: string; userId: string; state: 'unknown'|'pending'|'review'|'ready'; emailAddress?: string; accountId?: string; url?: string; expiresAt?: string }
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const grantKey=(device:ConnectorDevice)=>digest(canonical({companyId:device.companyId,profile:device.profile,installationId:device.installationId,tokenHash:device.tokenHash,id:device.id,memberId:device.memberId,licenseId:device.licenseId}));
/** Redelivery gives one active installation of this office a new credential
 * (provisioning checks both), so the owner's grant moves to it in the same
 * transaction. Revoke, mode change and a new mailbox still clear access; the
 * revision stays because the granted computer is the same one. */
export function carryMailboxGrant(db:ConnectorOptions['ledger']['db'],device:ConnectorDevice,tokenHash:string):void {
  db.run('CREATE TABLE IF NOT EXISTS office_mailbox_policy (company TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const row=db.get<{body:string}>('SELECT body FROM office_mailbox_policy WHERE company=?',device.companyId);if(!row)return;
  const policy:Policy=JSON.parse(row.body),from=grantKey(device);if(!officeMode(policy.mode)||!policy.grants.includes(from))return;
  const to=grantKey({...device,tokenHash});
  db.run('UPDATE office_mailbox_policy SET body=? WHERE company=?',canonical({...policy,grants:policy.grants.map(key=>key===from?to:key)}),device.companyId);
}
export class OfficeMailbox {
  private readonly options: ConnectorOptions;
  /** Moves the office's devices off a Gmail config nobody could connect before a shared link is issued. */
  private readonly prepareGmail?: (company:string,authority:()=>void)=>Promise<void>;
  constructor(options:ConnectorOptions,prepareGmail?:(company:string,authority:()=>void)=>Promise<void>) {
    this.options=options;this.prepareGmail=prepareGmail;
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS office_mailbox_policy (company TEXT PRIMARY KEY, body TEXT NOT NULL)');
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS office_mailbox_account (company TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  policy(company:string):Policy { const row=this.options.ledger.db.get<{body:string}>('SELECT body FROM office_mailbox_policy WHERE company=?',company);return row?JSON.parse(row.body):{mode:'personal',revision:0,grants:[]}; }
  private account(company:string):Mailbox|undefined {const row=this.options.ledger.db.get<{body:string}>('SELECT body FROM office_mailbox_account WHERE company=?',company);return row?JSON.parse(row.body):undefined;}
  private save(company:string,policy:Policy){this.options.ledger.db.run('INSERT INTO office_mailbox_policy(company,body) VALUES(?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body',company,canonical(policy));}
  private saveAccount(company:string,account:Mailbox){this.options.ledger.db.run('INSERT INTO office_mailbox_account(company,body) VALUES(?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body',company,canonical(account));}
  private provider(account:Mailbox):GmailReadOnlyBinding {const apiKey=this.options.secret(account.projectKeyEnv);requireThat(apiKey && /^ak_[A-Za-z0-9_-]{5,1000}$/.test(apiKey),'connector_not_configured',503);return {apiKey,authConfigId:account.authConfigId,userId:account.userId,accountId:account.accountId,acceptComposioManagedScopes:true};}
  fingerprint(device:ConnectorDevice):string {const policy=this.policy(device.companyId);return canonical({device,policy,account:officeMode(policy.mode)?this.account(device.companyId):undefined});}
  /** The mailbox a request uses: the office one in `shared`; in `both` only when
   * the request selects it (or names its exact account); never in `personal`. */
  source(company:string,requested?:MailboxSource):MailboxSource {
    const mode=this.policy(company).mode;
    if(mode==='shared')return 'office';
    if(requested==='office'){requireThat(mode==='both','office_mailbox_shared_required',409);return 'office';}
    return 'personal';
  }
  /** True when `accountId` is this office's confirmed shared account (routing only; `binding` still checks the grant). */
  isOfficeAccount(company:string,accountId:unknown):boolean {const account=this.account(company);return officeMode(this.policy(company).mode)&&account?.state==='ready'&&typeof accountId==='string'&&account.accountId===accountId;}
  /** Safe setup projection only; this never reads a secret or authorizes a read. */
  readyForDevice(device:ConnectorDevice):boolean {
    const policy=this.policy(device.companyId),account=this.account(device.companyId);
    return officeMode(policy.mode)&&policy.grants.includes(grantKey(device))&&account?.state==='ready'&&Boolean(account.accountId)
      &&device.projectKeyEnv===account.projectKeyEnv&&device.authConfigId===account.authConfigId;
  }
  /** Ask's Gmail scope for this office: a member's own mailbox is full (owner
   * decision 2026-10-02); a shared mailbox is full only under the owner's
   * current versioned grant, otherwise the three bounded reads. */
  mailboxAccess(company:string,source:MailboxSource=this.source(company)):'full'|'read_only' {
    const policy=this.policy(company);
    return source==='personal'||policy.fullMailboxAccess?.version===FULL_MAILBOX_ACCESS_VERSION?'full':'read_only';
  }
  binding(device:ConnectorDevice,source:MailboxSource=this.source(device.companyId)):GmailReadOnlyBinding|undefined {
    const policy=this.policy(device.companyId);if(source==='personal')return undefined;requireThat(officeMode(policy.mode),'office_mailbox_shared_required',409);
    requireThat(policy.grants.includes(grantKey(device)),'office_mailbox_desktop_denied',403);
    const account=this.account(device.companyId);requireThat(account?.state==='ready' && account.accountId,'office_mailbox_not_connected',409);
    requireThat(device.projectKeyEnv===account.projectKeyEnv && device.authConfigId===account.authConfigId,'office_mailbox_binding_changed',409);
    return this.provider(account);
  }
  private status(company:string){const policy=this.policy(company),account=officeMode(policy.mode)?this.account(company):undefined,full=policy.fullMailboxAccess;return {mode:policy.mode,revision:policy.revision,state:account?.state??'not_connected',
    fullMailboxAccess:full?.version===FULL_MAILBOX_ACCESS_VERSION?{granted:true,version:full.version,grantedBy:full.grantedBy,grantedAt:full.grantedAt}:{granted:false},...(account?.state==='ready'?{accountId:account.accountId}:{}),...(account?.state==='review'?{candidate:{accountId:account.accountId,emailAddress:account.emailAddress}}:{}),installations:this.options.devices().filter(d=>d.companyId===company).map(d=>({installationId:d.installationId,active:d.active,allowed:d.active&&policy.grants.includes(grantKey(d))}))};}
  async handle(actor:PortalPrincipal,operation:string,body:unknown,revalidate:()=>Promise<void>){
    requireThat(actor.role==='billing_owner','forbidden',403);const company=actor.companyId;
    if(operation==='status')return this.status(company);
    object(body); const access=operation==='policy'&&Object.hasOwn(body,'fullMailboxAccess');
    const fields=access?(body.fullMailboxAccess===true?['mode','expectedRevision','fullMailboxAccess','acknowledgement']:['mode','expectedRevision','fullMailboxAccess']):operation==='policy'?['mode','expectedRevision']:operation==='grants'?['installationId','allowed','expectedRevision']:operation==='confirm'?['expectedRevision','accountId','emailAddress']:['expectedRevision'];exact(body,fields);
    const policy=this.policy(company);requireThat(body.expectedRevision===policy.revision,'office_mailbox_revision_changed',409);
    const check=()=>{requireThat(this.policy(company).revision===policy.revision,'office_mailbox_revision_changed',409);};
    const current=async()=>{await revalidate();check();};
    if(access){
      // Owner-only (above), on the current shared mailbox, with the exact wording.
      // Granting and revoking each move the revision, so every desktop re-reviews.
      requireThat(body.mode===policy.mode&&officeMode(policy.mode)&&typeof body.fullMailboxAccess==='boolean','office_mailbox_shared_required',409);
      if(body.fullMailboxAccess){
        requireThat(body.acknowledgement===FULL_MAILBOX_ACCESS_WORDING,'office_mailbox_access_wording_required',400);
        requireThat(this.account(company)?.state==='ready','office_mailbox_confirmation_required',409);
      }
      const now=this.options.ledger.now();
      const {fullMailboxAccess:_previous,...rest}=policy;
      this.options.ledger.db.transaction(()=>{
        this.save(company,{...rest,revision:policy.revision+1,...(body.fullMailboxAccess?{fullMailboxAccess:{version:FULL_MAILBOX_ACCESS_VERSION,grantedBy:actor.subject,grantedAt:new Date(now).toISOString()}}:{})});
        this.options.ledger.db.append(company,body.fullMailboxAccess?'office_mailbox_full_access_granted':'office_mailbox_full_access_revoked',null,now,{by:actor.subject,version:FULL_MAILBOX_ACCESS_VERSION,revision:policy.revision+1});
      });return this.status(company);
    }
    if(operation==='policy'){
      requireThat(MODES.includes(body.mode as MailboxMode),'invalid_mailbox_mode');
      const mode=body.mode as MailboxMode;
      // shared <-> both keeps the same office mailbox, its confirmed address, its
      // granted computers and any full-access grant: neither direction widens who
      // can use it (in `both` it is used only when a request selects it). The
      // revision still moves, so every desktop re-reviews. Any other change,
      // including re-choosing the current mode, starts the office mailbox over.
      const keep=mode!==policy.mode&&officeMode(mode)&&officeMode(policy.mode);
      this.options.ledger.db.transaction(()=>{
        const previous=this.account(company);
        if(!keep&&previous&&(previous.state==='ready'||previous.state==='review'))this.saveAccount(company,{...previous,state:'pending',emailAddress:undefined,url:undefined});
        this.save(company,keep?{...policy,mode,revision:policy.revision+1}:{mode,revision:policy.revision+1,grants:[]});
      });return this.status(company);
    }
    requireThat(officeMode(policy.mode),'office_mailbox_shared_required',409);
    if(operation==='grants'){
      requireThat(typeof body.installationId==='string'&&typeof body.allowed==='boolean','invalid_mailbox_grant');
      requireThat(!body.allowed||this.account(company)?.state==='ready','office_mailbox_confirmation_required',409);
      const devices=this.options.devices().filter(d=>d.companyId===company&&d.installationId===body.installationId);
      requireThat(devices.length===1 && (!body.allowed||devices[0]!.active),'office_mailbox_installation_unavailable',409);
      const device=devices[0]!; const grants=policy.grants.filter(h=>h!==grantKey(device));if(body.allowed)grants.push(grantKey(device));
      this.save(company,{...policy,revision:policy.revision+1,grants});return this.status(company);
    }
    requireThat(operation==='authorize'||operation==='verify'||operation==='confirm','not_found',404);
    const tenant=this.options.ledger.tenant(company),now=this.options.ledger.now();requireThat(tenant.active&&tenant.serviceExpiresAt>now&&now>=tenant.goLiveAt,'service_unavailable',402);
    const authority=()=>{check();const t=this.options.ledger.tenant(company);requireThat(t.active&&t.serviceExpiresAt>this.options.ledger.now(),'service_unavailable',402);};
    let account=this.account(company);
    if(operation==='authorize'){
      let lapsed:string|undefined;
      if(account){
        requireThat(account.state!=='unknown','office_mailbox_link_outcome_unknown',409);
        requireThat(account.state==='pending','office_mailbox_link_needs_recovery',409);
        if(account.url&&Date.parse(account.expiresAt??'')>now)return {url:account.url,revision:policy.revision};
        // The link lapsed (or a mode change retired it). A fresh link replaces it
        // only once the provider says the account it started never connected; a
        // connected one is verified instead, and an unanswered check keeps the hold.
        if(account.accountId){
          const receipt=canonical(account);let result:Awaited<ReturnType<typeof getGmailReadOnlyAccess>>;
          try{result=await(this.options.access??getGmailReadOnlyAccess)({...this.provider(account),assertAuthority:authority});}
          catch(error){if(error instanceof GatewayError)throw error;throw new GatewayError('office_mailbox_link_needs_recovery',409);}
          await current();authority();requireThat(canonical(this.account(company))===receipt,'office_mailbox_binding_changed',409);
          requireThat(!(result.services.gmail?.accounts??[]).some(a=>a.id===account!.accountId&&a.status==='ACTIVE'),'office_mailbox_verify_required',409);
          lapsed=account.accountId;
        }
      }
      await this.prepareGmail?.(company,authority);
      const devices=this.options.devices().filter(d=>d.companyId===company&&d.active);requireThat(devices.length>0,'office_mailbox_installation_required',409);
      const first=devices[0]!;requireThat(devices.every(d=>d.projectKeyEnv===first.projectKeyEnv&&d.authConfigId===first.authConfigId),'office_mailbox_configuration_conflict',409);
      account={projectKeyEnv:first.projectKeyEnv,authConfigId:first.authConfigId,userId:`office_${digest(company)}`,state:'unknown'};
      const binding=this.provider(account);
      this.options.ledger.db.transaction(()=>{this.saveAccount(company,account!);if(lapsed!==undefined)this.options.ledger.db.append(company,'office_mailbox_link_replaced',null,now,{lapsedAccountId:lapsed,revision:policy.revision});});
      const result=await(this.options.authorize??authorizeGmailReadOnly)({...binding,assertAuthority:authority});
      // Keep the exact receipt even if policy/owner authority changed in flight.
      this.saveAccount(company,{...account,...result,state:'pending'});await current();authority();return {url:result.url,revision:policy.revision};
    }
    requireThat(account&&account.state!=='unknown'&&account.accountId,'office_mailbox_link_outcome_unknown',409);
    if(operation==='verify')requireThat(account.state==='pending'||account.state==='review','office_mailbox_already_confirmed',409);
    if(operation==='confirm')requireThat(account.state==='review'&&body.accountId===account.accountId&&body.emailAddress===account.emailAddress,'office_mailbox_candidate_changed',409);
    const receipt=canonical(account);
    const result=await(this.options.access??getGmailReadOnlyAccess)({...this.provider(account),assertAuthority:authority});await current();authority();
    requireThat(canonical(this.account(company))===receipt,'office_mailbox_binding_changed',409);
    const gmail=result.services.gmail,active=Boolean(gmail?.connected&&gmail.accounts.some(a=>a.id===account.accountId&&a.status==='ACTIVE'));
    if(!active&&account.state==='pending'){
      // Unfinished Google consent is not a failure: say which next step applies.
      const status=gmail?.accounts.find(a=>a.id===account.accountId)?.status;
      if(!account.url||Date.parse(account.expiresAt??'')<=this.options.ledger.now()||status==='EXPIRED'||status==='FAILED'||status==='INACTIVE')throw new GatewayError('office_mailbox_link_expired',409);
      if(status==='INITIATED'||status==='INITIALIZING')throw new GatewayError('office_mailbox_consent_pending',409);
    }
    requireThat(active,'office_mailbox_not_connected',409);
    const transport=(this.options.transport??createGmailReadOnlyTransport)({...this.provider(account),assertAuthority:authority});
    const profile=await transport.request('tools/call',{name:'GMAIL_GET_PROFILE',arguments:{}},AbortSignal.timeout(30_000));await current();authority();
    requireThat(canonical(this.account(company))===receipt,'office_mailbox_binding_changed',409);
    requireThat(!profile.isError&&Array.isArray(profile.content)&&profile.content.length===1&&profile.content[0]?.type==='text'&&typeof profile.content[0].text==='string','office_mailbox_identity_unverified',409);
    let identity:unknown;try{identity=JSON.parse(profile.content[0].text);}catch{requireThat(false,'office_mailbox_identity_unverified',409);}
    object(identity);requireThat(identity.accountId===account.accountId&&typeof identity.emailAddress==='string'&&/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(identity.emailAddress),'office_mailbox_identity_unverified',409);
    if(operation==='confirm')requireThat(identity.emailAddress===account.emailAddress,'office_mailbox_candidate_changed',409);
    this.options.ledger.db.transaction(()=>{
      this.saveAccount(company,{...account,emailAddress:identity.emailAddress as string,state:operation==='confirm'?'ready':'review',url:undefined});
      // A newly verified candidate is a different mailbox: its grants and any full access start over.
      const {fullMailboxAccess,...rest}=policy;
      this.save(company,{...rest,revision:policy.revision+1,grants:operation==='confirm'?policy.grants:[],...(operation==='confirm'&&fullMailboxAccess?{fullMailboxAccess}:{})});
    });return this.status(company);
  }
}
