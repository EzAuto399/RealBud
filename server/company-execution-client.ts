import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { createPrivateVault } from './private-vault.ts';
import { canonicalWebsiteCommand } from '../shared/website-commands.ts';
import { companyExecutionUuid, companyExecutionSecret, isBeginCompanyExecution, isCompanyExecutionGrant, isAdmitCompanyExecution, isRenewCompanyExecution, isSettleCompanyExecution, isCompanyExecutionReceipt, isCompanyExecutionCheck, isCompanyExecutionSettlement, type BeginCompanyExecution, type CompanyExecutionGrant, type AdmitCompanyExecution, type CompanyExecutionReceipt, type CheckCompanyExecution, type RenewCompanyExecution, type SettleCompanyExecution, type CompanyExecutionSettlement } from '../shared/company-execution.ts';

type Identity = { companyId: string; memberId: string; workspaceId: string; workerBinding: string; certificateDigest: string };
type Reply = { status: number; body: unknown };
type BeginInput = Omit<BeginCompanyExecution,'grantSecret'|'executor'>;
type Attempt<T,R> = { input: T; receipt?: R };
type Saved = {
  version: 1; identity: Identity; begin: BeginCompanyExecution; grant?: CompanyExecutionGrant;
  admission?: Attempt<AdmitCompanyExecution,CompanyExecutionReceipt>;
  renewals: Attempt<RenewCompanyExecution,CompanyExecutionReceipt>[];
  settlement?: Attempt<SettleCompanyExecution,CompanyExecutionSettlement>;
};
/** Persisted observations for recovery, never proof of current host authority. */
export type CompanyExecutionLocal = {
  grant?: CompanyExecutionGrant;
  admission?: { executionId: string; receipt?: CompanyExecutionReceipt };
  settlement?: { input: Pick<SettleCompanyExecution,'requestId'|'runId'|'outcome'|'note'>; receipt?: CompanyExecutionSettlement };
};
const commandDigest = (v: unknown) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const PREFIX = 'department-execution-';
// Leave room for the encrypted envelope under the vault's 2 MB reader bound.
const MAX_SAVED_BYTES = 1_400_000;
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string,unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
function fail(status = 409): never { throw Object.assign(new Error('Department execution could not be confirmed. Keep the saved request and review its status before starting another run.'), {status,code:'department_execution_held'}); };
function identity(v: unknown): v is Identity {
  return object(v) && keys(v,['companyId','memberId','workspaceId','workerBinding','certificateDigest']) && [v.companyId,v.memberId,v.workspaceId].every(companyExecutionUuid) && companyExecutionSecret(v.workerBinding) && companyExecutionSecret(v.certificateDigest);
}
function decode(value: unknown, id: string): Saved {
  if (!object(value) || value.version !== 1 || !keys(value,['version','identity','begin','renewals',...['grant','admission','settlement'].filter(k=>k in value)]) || !identity(value.identity) || !isBeginCompanyExecution(value.begin) || value.begin.requestId !== id || !Array.isArray(value.renewals) || value.renewals.length > 4096) fail(503);
  if (Buffer.byteLength(JSON.stringify(value),'utf8') > MAX_SAVED_BYTES) fail(503);
  const saved = value as unknown as Saved;
  if (!isDeepStrictEqual(saved.begin.executor,{workspaceId:saved.identity.workspaceId,workerBinding:saved.identity.workerBinding})) fail(503);
  if (saved.grant !== undefined) validateGrant(saved, saved.grant);
  function attempt<T,R>(v: unknown, input: (v: unknown)=>v is T, receipt: (v: unknown)=>v is R): asserts v is Attempt<T,R> {
    if (!object(v) || !keys(v,['input',...('receipt' in v?['receipt']:[])]) || !input(v.input) || ('receipt' in v && !receipt(v.receipt))) fail(503);
  }
  if (saved.admission) {
    attempt(saved.admission,isAdmitCompanyExecution,isCompanyExecutionReceipt);
    if (!saved.grant || saved.admission.input.grantId !== id) fail(503);
    if (saved.admission.receipt) validateReceipt(saved,saved.admission.input,saved.admission.receipt);
  }
  for (const entry of saved.renewals) {
    attempt(entry,isRenewCompanyExecution,isCompanyExecutionReceipt);
    if (!saved.admission?.receipt || !sameClaim(entry.input,claim(saved))) fail(503);
    if (entry.receipt) validateReceipt(saved,entry.input,entry.receipt);
  }
  if (new Set(saved.renewals.map(r=>r.input.requestId)).size !== saved.renewals.length) fail(503);
  if (saved.settlement) {
    attempt(saved.settlement,isSettleCompanyExecution,isCompanyExecutionSettlement);
    if (!saved.admission?.receipt || !sameClaim(saved.settlement.input,claim(saved))) fail(503);
    if (saved.settlement.receipt) validateSettlement(saved,saved.settlement.input,saved.settlement.receipt);
  }
  return saved;
}
function validateGrant(s: Saved, g: unknown): asserts g is CompanyExecutionGrant {
  if (!isCompanyExecutionGrant(g) || g.id !== s.begin.requestId || g.digest !== commandDigest(g.spec) || g.spec.sourceDigest !== commandDigest(g.source) ||
    g.spec.companyId !== s.identity.companyId || g.spec.memberId !== s.identity.memberId || g.spec.certificateDigest !== s.identity.certificateDigest ||
    !isDeepStrictEqual(g.spec.executor,s.begin.executor) || !isDeepStrictEqual(g.spec.recipe,s.begin.recipe) || g.spec.departmentId !== s.begin.departmentId ||
    g.spec.departmentRevision !== s.begin.expectedDepartmentRevision || g.spec.caseId !== s.begin.caseId || g.spec.caseFence !== s.begin.expectedCaseFence ||
    Date.parse(g.expiresAt)-Date.parse(g.createdAt) !== s.begin.durationMs) fail(503);
  if (s.grant) {
    const prior=s.grant;
    if (!isDeepStrictEqual(g.spec,prior.spec)||!isDeepStrictEqual(g.source,prior.source)||g.digest!==prior.digest||g.createdAt!==prior.createdAt||g.expiresAt!==prior.expiresAt||
      BigInt(g.revision)<BigInt(prior.revision)||prior.confirmedAt!==null&&g.confirmedAt!==prior.confirmedAt||prior.revokedAt!==null&&g.revokedAt!==prior.revokedAt||
      ['pending','active','admitted','revoked'].indexOf(g.phase)<['pending','active','admitted','revoked'].indexOf(prior.phase)||
      g.revision===prior.revision&&(g.phase!==prior.phase||g.confirmedAt!==prior.confirmedAt||g.revokedAt!==prior.revokedAt)) fail(503);
  }
}
function validateReceipt(s: Saved, input: AdmitCompanyExecution | RenewCompanyExecution, r: unknown): asserts r is CompanyExecutionReceipt {
  if (!isCompanyExecutionReceipt(r) || r.grantId !== input.grantId || r.receiptId !== input.requestId || r.executionId !== input.executionId || r.caseId !== s.begin.caseId ||
    r.fence !== String(BigInt(s.begin.expectedCaseFence)+BigInt(1)) || !s.grant || Date.parse(r.leaseExpiresAt)>Date.parse(s.grant.expiresAt) ||
    s.admission?.receipt && r.dispatchBefore !== s.admission.receipt.dispatchBefore) fail(503);
}
function sameClaim(a: CheckCompanyExecution,b: CheckCompanyExecution) { return ['version','grantId','executionId','claimSecret','fence'].every(k=>a[k as keyof CheckCompanyExecution]===b[k as keyof CheckCompanyExecution]); }
function claim(s: Saved): CheckCompanyExecution {
  if (!s.admission?.receipt) fail();
  const input=s.admission.input;
  return {version:1,grantId:input.grantId,executionId:input.executionId,claimSecret:input.claimSecret,fence:s.admission.receipt.fence};
}
function validateSettlement(s: Saved,input: SettleCompanyExecution,r: unknown): asserts r is CompanyExecutionSettlement {
  if (!isCompanyExecutionSettlement(r) || r.receiptId !== input.requestId || r.caseId !== s.begin.caseId || r.runId !== input.runId || r.outcome !== input.outcome || r.fence !== String(BigInt(input.fence)+BigInt(1))) fail(503);
}

/** Trusted per-installation client. No secret or general session is returned to
 * a renderer. Every network mutation has a durable, exact encrypted intent. */
export function createCompanyExecutionClient(options: {
  vault: ReturnType<typeof createPrivateVault>;
  identity(): Promise<Identity>;
  forward(path: string, auth: { memberToken: string } | { executionToken: string }, body?: unknown): Promise<Reply>;
  now?: ()=>number;
}) {
  let queue: Promise<unknown> = Promise.resolve(), waiting=0;
  const now=options.now??Date.now;
  function serial<T>(work:()=>Promise<T>):Promise<T> {
    if(waiting>=32)return Promise.reject(Object.assign(new Error('Department execution is busy.'),{status:429}));
    waiting++;const run=queue.then(work);queue=run.catch(()=>{}).finally(()=>{waiting--;});return run;
  }
  async function current(expected?: Identity) {
    const actual=await options.identity();if(!identity(actual) || expected && !isDeepStrictEqual(actual,expected))fail();return actual;
  }
  async function read(id:string):Promise<Saved|undefined> {
    if(!companyExecutionUuid(id))fail(400);
    const raw=await options.vault.read(PREFIX+id);return raw===undefined?undefined:decode(raw,id);
  }
  async function write(s:Saved) { if (Buffer.byteLength(JSON.stringify(s),'utf8') > MAX_SAVED_BYTES) fail(503); await options.vault.write(PREFIX+s.begin.requestId,s); }
  async function rpc(s:Saved,path:string,input:unknown,memberToken?:string) {
    await current(s.identity);
    const result=await options.forward(path,memberToken?{memberToken}:{executionToken:s.begin.grantSecret},input);
    // A changed seat, host, worker or connection after an await invalidates the
    // returned authority. The exact saved intent remains available for review.
    await current(s.identity);
    if(result.status!==200)fail([400,401,403,404,409,422].includes(result.status)?result.status:503);
    return result.body;
  }
  async function load(id:string) { const s=await read(id);if(!s)fail(404);await current(s.identity);return s; }
  async function check(s:Saved) {
    if(s.settlement)fail();
    const result=await rpc(s,'/api/company/execution/check',claim(s));
    if(!isCompanyExecutionCheck(result))fail(503);
    const r=result.receipt,admit=s.admission!.receipt!;
    if(!(r.receiptId===s.admission!.input.requestId||s.renewals.some(entry=>entry.input.requestId===r.receiptId))||r.grantId!==admit.grantId||r.executionId!==admit.executionId||r.caseId!==admit.caseId||r.fence!==admit.fence||r.dispatchBefore!==admit.dispatchBefore||
      Date.parse(r.leaseExpiresAt)>Date.parse(s.grant!.expiresAt)||Date.parse(r.leaseExpiresAt)<=now()||commandDigest(result.source)!==s.grant!.spec.sourceDigest)fail();
    return result;
  }
  return {
    status:(grantId:string):Promise<CompanyExecutionGrant>=>serial(async()=>{
      const s=await load(grantId);
      const grant=await rpc(s,'/api/company/execution/status',{version:1,grantId});
      validateGrant(s,grant);s.grant=grant;await write(s);return grant;
    }),
    local:(grantId:string):Promise<CompanyExecutionLocal>=>serial(async()=>{
      const s=await read(grantId);if(!s)return {};
      const result:CompanyExecutionLocal={};
      if(s.grant)result.grant=s.grant;
      if(s.admission)result.admission={executionId:s.admission.input.executionId,...(s.admission.receipt?{receipt:s.admission.receipt}:{})};
      if(s.settlement){const {requestId,runId,outcome,note}=s.settlement.input;result.settlement={input:{requestId,runId,outcome,note},...(s.settlement.receipt?{receipt:s.settlement.receipt}:{})};}
      return structuredClone(result);
    }),
    begin: (memberToken:string,input:BeginInput):Promise<CompanyExecutionGrant> => serial(async()=>{
      const actual=await current();
      const old=await read(input.requestId);
      const begin={...input,grantSecret:old?.begin.grantSecret??randomBytes(32).toString('hex'),executor:{workspaceId:actual.workspaceId,workerBinding:actual.workerBinding}};
      if(!isBeginCompanyExecution(begin))fail(400);
      if(old && (!isDeepStrictEqual(old.begin,begin)||!isDeepStrictEqual(old.identity,actual)))fail();
      const s:Saved=old??{version:1,identity:actual,begin,renewals:[]};
      // The session proves the stored seat before any secret is transmitted.
      const own=await options.forward('/api/company/me',{memberToken});
      if(own.status!==200||!object(own.body)||!object(own.body.company)||!object(own.body.member)||own.body.company.id!==actual.companyId||own.body.member.id!==actual.memberId)fail(403);
      await current(actual);
      if(!old){const all=await options.vault.names(PREFIX,1000);if(all.hasMore||all.names.length>=1000)fail();await write(s);}
      const g=await rpc(s,'/api/company/execution-grants/begin',s.begin,memberToken);validateGrant(s,g);s.grant=g;await write(s);return g;
    }),
    admit:(grantId:string,executionId:string,ttlMs=300000):Promise<CompanyExecutionReceipt>=>serial(async()=>{
      const s=await load(grantId);if(!s.grant||s.settlement)fail();
      const input:AdmitCompanyExecution=s.admission?.input??{version:1,grantId,requestId:randomUUID(),executionId,claimSecret:randomBytes(32).toString('hex'),ttlMs};
      if(input.executionId!==executionId||input.ttlMs!==ttlMs||!isAdmitCompanyExecution(input))fail();
      if(!s.admission){s.admission={input};await write(s);}
      const receipt=await rpc(s,'/api/company/execution/admit',input);validateReceipt(s,input,receipt);s.admission.receipt=receipt;await write(s);return receipt;
    }),
    check:(grantId:string)=>serial(async()=>check(await load(grantId))),
    beforeDispatch:(grantId:string)=>serial(async()=>{
      const s=await load(grantId),result=await check(s);
      if(Date.parse(result.receipt.dispatchBefore)<=now())fail();return result;
    }),
    renew:(grantId:string,requestId:string,ttlMs=300000):Promise<CompanyExecutionReceipt>=>serial(async()=>{
      const s=await load(grantId);if(s.settlement)fail();
      const input:RenewCompanyExecution={...claim(s),requestId,ttlMs};if(!isRenewCompanyExecution(input))fail(400);
      let entry=s.renewals.find(r=>r.input.requestId===requestId);
      if(entry&&!isDeepStrictEqual(entry.input,input))fail();
      if(!entry){if(s.renewals.length>=4096)fail();entry={input};s.renewals.push(entry);await write(s);}
      const receipt=await rpc(s,'/api/company/execution/renew',input);validateReceipt(s,input,receipt);entry.receipt=receipt;await write(s);return receipt;
    }),
    settle:(grantId:string,result:{requestId:string;runId:string;outcome:SettleCompanyExecution['outcome'];note:string}):Promise<CompanyExecutionSettlement>=>serial(async()=>{
      const s=await load(grantId),input:SettleCompanyExecution={...claim(s),...result};if(!isSettleCompanyExecution(input))fail(400);
      if(s.settlement&&!isDeepStrictEqual(s.settlement.input,input))fail();
      if(!s.settlement){s.settlement={input};await write(s);}
      // A denied settlement still preserves its factual local result. It cannot
      // close, reopen or release a case held by a newer fence.
      const receipt=await rpc(s,'/api/company/execution/settle',input);validateSettlement(s,input,receipt);s.settlement.receipt=receipt;await write(s);return receipt;
    }),
    drain:()=>queue,
  };
}
