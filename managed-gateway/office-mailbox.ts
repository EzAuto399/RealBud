/** Gateway-owned office policy. Shared Gmail remains a PRIVATE provider account;
 * only these credential-bound grants allow a desktop to use it. */
import { createHash } from 'node:crypto';
import { canonical, exact, object, requireThat, type PortalPrincipal } from './contracts.ts';
import type { ConnectorDevice, ConnectorOptions } from './connectors.ts';
import { authorizeGmailReadOnly, getGmailReadOnlyAccess, createGmailReadOnlyTransport, type GmailReadOnlyBinding } from '../server/composio-gmail.ts';
interface Policy { mode: 'personal'|'shared'; revision: number; grants: string[] }
interface Mailbox { projectKeyEnv: string; authConfigId: string; userId: string; state: 'unknown'|'pending'|'review'|'ready'; emailAddress?: string; accountId?: string; url?: string; expiresAt?: string }
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const grantKey=(device:ConnectorDevice)=>digest(canonical({companyId:device.companyId,profile:device.profile,installationId:device.installationId,tokenHash:device.tokenHash,id:device.id,memberId:device.memberId,licenseId:device.licenseId}));
export class OfficeMailbox {
  private readonly options: ConnectorOptions;
  constructor(options:ConnectorOptions) {
    this.options=options;
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS office_mailbox_policy (company TEXT PRIMARY KEY, body TEXT NOT NULL)');
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS office_mailbox_account (company TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  policy(company:string):Policy { const row=this.options.ledger.db.get<{body:string}>('SELECT body FROM office_mailbox_policy WHERE company=?',company);return row?JSON.parse(row.body):{mode:'personal',revision:0,grants:[]}; }
  private account(company:string):Mailbox|undefined {const row=this.options.ledger.db.get<{body:string}>('SELECT body FROM office_mailbox_account WHERE company=?',company);return row?JSON.parse(row.body):undefined;}
  private save(company:string,policy:Policy){this.options.ledger.db.run('INSERT INTO office_mailbox_policy(company,body) VALUES(?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body',company,canonical(policy));}
  private saveAccount(company:string,account:Mailbox){this.options.ledger.db.run('INSERT INTO office_mailbox_account(company,body) VALUES(?,?) ON CONFLICT(company) DO UPDATE SET body=excluded.body',company,canonical(account));}
  private provider(account:Mailbox):GmailReadOnlyBinding {const apiKey=this.options.secret(account.projectKeyEnv);requireThat(apiKey && /^ak_[A-Za-z0-9_-]{5,1000}$/.test(apiKey),'connector_not_configured',503);return {apiKey,authConfigId:account.authConfigId,userId:account.userId,accountId:account.accountId};}
  fingerprint(device:ConnectorDevice):string {const policy=this.policy(device.companyId);return canonical({device,policy,account:policy.mode==='shared'?this.account(device.companyId):undefined});}
  /** Safe setup projection only; this never reads a secret or authorizes a read. */
  readyForDevice(device:ConnectorDevice):boolean {
    const policy=this.policy(device.companyId),account=this.account(device.companyId);
    return policy.mode==='shared'&&policy.grants.includes(grantKey(device))&&account?.state==='ready'&&Boolean(account.accountId)
      &&device.projectKeyEnv===account.projectKeyEnv&&device.authConfigId===account.authConfigId;
  }
  binding(device:ConnectorDevice):GmailReadOnlyBinding|undefined {
    const policy=this.policy(device.companyId);if(policy.mode==='personal')return undefined;
    requireThat(policy.grants.includes(grantKey(device)),'office_mailbox_desktop_denied',403);
    const account=this.account(device.companyId);requireThat(account?.state==='ready' && account.accountId,'office_mailbox_not_connected',409);
    requireThat(device.projectKeyEnv===account.projectKeyEnv && device.authConfigId===account.authConfigId,'office_mailbox_binding_changed',409);
    return this.provider(account);
  }
  private status(company:string){const policy=this.policy(company),account=policy.mode==='shared'?this.account(company):undefined;return {mode:policy.mode,revision:policy.revision,state:account?.state??'not_connected',...(account?.state==='ready'?{accountId:account.accountId}:{}),...(account?.state==='review'?{candidate:{accountId:account.accountId,emailAddress:account.emailAddress}}:{}),installations:this.options.devices().filter(d=>d.companyId===company).map(d=>({installationId:d.installationId,active:d.active,allowed:d.active&&policy.grants.includes(grantKey(d))}))};}
  async handle(actor:PortalPrincipal,operation:string,body:unknown,revalidate:()=>Promise<void>){
    requireThat(actor.role==='billing_owner','forbidden',403);const company=actor.companyId;
    if(operation==='status')return this.status(company);
    object(body); const fields=operation==='policy'?['mode','expectedRevision']:operation==='grants'?['installationId','allowed','expectedRevision']:operation==='confirm'?['expectedRevision','accountId','emailAddress']:['expectedRevision'];exact(body,fields);
    const policy=this.policy(company);requireThat(body.expectedRevision===policy.revision,'office_mailbox_revision_changed',409);
    const check=()=>{requireThat(this.policy(company).revision===policy.revision,'office_mailbox_revision_changed',409);};
    const current=async()=>{await revalidate();check();};
    if(operation==='policy'){
      requireThat(body.mode==='personal'||body.mode==='shared','invalid_mailbox_mode');
      const mode=body.mode;
      this.options.ledger.db.transaction(()=>{
        const previous=this.account(company);
        if(previous&&(previous.state==='ready'||previous.state==='review'))this.saveAccount(company,{...previous,state:'pending',emailAddress:undefined,url:undefined});
        this.save(company,{mode,revision:policy.revision+1,grants:[]});
      });return this.status(company);
    }
    requireThat(policy.mode==='shared','office_mailbox_shared_required',409);
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
      if(account){requireThat(account.state!=='unknown','office_mailbox_link_outcome_unknown',409);requireThat(account.state==='pending'&&account.url&&Date.parse(account.expiresAt??'')>now,'office_mailbox_link_needs_recovery',409);return {url:account.url,revision:policy.revision};}
      const devices=this.options.devices().filter(d=>d.companyId===company&&d.active);requireThat(devices.length>0,'office_mailbox_installation_required',409);
      const first=devices[0]!;requireThat(devices.every(d=>d.projectKeyEnv===first.projectKeyEnv&&d.authConfigId===first.authConfigId),'office_mailbox_configuration_conflict',409);
      account={projectKeyEnv:first.projectKeyEnv,authConfigId:first.authConfigId,userId:`office_${digest(company)}`,state:'unknown'};
      const binding=this.provider(account);this.saveAccount(company,account);
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
    requireThat(result.services.gmail?.connected&&result.services.gmail.accounts.some(a=>a.id===account.accountId&&a.status==='ACTIVE'),'office_mailbox_not_connected',409);
    const transport=(this.options.transport??createGmailReadOnlyTransport)({...this.provider(account),assertAuthority:authority});
    const profile=await transport.request('tools/call',{name:'GMAIL_GET_PROFILE',arguments:{}},AbortSignal.timeout(30_000));await current();authority();
    requireThat(canonical(this.account(company))===receipt,'office_mailbox_binding_changed',409);
    requireThat(!profile.isError&&Array.isArray(profile.content)&&profile.content.length===1&&profile.content[0]?.type==='text'&&typeof profile.content[0].text==='string','office_mailbox_identity_unverified',409);
    let identity:unknown;try{identity=JSON.parse(profile.content[0].text);}catch{requireThat(false,'office_mailbox_identity_unverified',409);}
    object(identity);requireThat(identity.accountId===account.accountId&&typeof identity.emailAddress==='string'&&/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(identity.emailAddress),'office_mailbox_identity_unverified',409);
    if(operation==='confirm')requireThat(identity.emailAddress===account.emailAddress,'office_mailbox_candidate_changed',409);
    this.options.ledger.db.transaction(()=>{
      this.saveAccount(company,{...account,emailAddress:identity.emailAddress as string,state:operation==='confirm'?'ready':'review',url:undefined});
      this.save(company,{...policy,revision:policy.revision+1,grants:operation==='confirm'?policy.grants:[]});
    });return this.status(company);
  }
}
