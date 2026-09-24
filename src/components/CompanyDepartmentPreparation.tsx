import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CompanyStatus, DepartmentCase, DepartmentCasePage } from '@shared/company-api';
import { isDepartmentWorkPrepare, type DepartmentWorkPrepare, type DepartmentWorkPage, type DepartmentWorkCatalog, type DepartmentWorkState } from '@shared/department-work';
import { companyExecutionUuid, isConfirmCompanyExecution, isRevokeCompanyExecution, type CompanyExecutionGrant, type CompanyExecutionReview, type ConfirmCompanyExecution, type RevokeCompanyExecution } from '@shared/company-execution';
import { remoteExact } from '@shared/website-remote-approvers';
import { canonicalWebsiteCommand } from '@shared/website-commands';
import { companyApi, departmentMutationUncertain } from '@/lib/company-api';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[14px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'min-h-11 w-full min-w-0 rounded-lg border border-line bg-sheet p-3 text-ink focus-visible:outline-2 focus-visible:outline-agency';
const phases: Record<DepartmentWorkState['phase'],string> = { requesting:'Request needs confirmation', 'waiting-owner':'Waiting for owner approval', admitting:'Checking permission to start', running:'Preparing on the assigned instance', 'review-required':'Result needs human review', held:'Preparation held' };
export type DepartmentPreparationOperation = { departmentId:string } & (
  {kind:'prepare';input:DepartmentWorkPrepare} | {kind:'confirm';input:ConfirmCompanyExecution} |
  {kind:'revoke';input:RevokeCompanyExecution} | {kind:'reconcile';input:{grantId:string}});
export function isDepartmentPreparationOperation(value: unknown): value is DepartmentPreparationOperation {
  if (!remoteExact(value,['departmentId','kind','input']) || !companyExecutionUuid(value.departmentId)) return false;
  return value.kind === 'prepare' ? isDepartmentWorkPrepare(value.input) && value.input.departmentId === value.departmentId
    : value.kind === 'confirm' ? isConfirmCompanyExecution(value.input)
    : value.kind === 'revoke' ? isRevokeCompanyExecution(value.input)
    : value.kind === 'reconcile' && remoteExact(value.input,['grantId']) && companyExecutionUuid(value.input.grantId);
}
export function canRequestDepartmentPreparation(data: DepartmentCasePage | null, item: DepartmentCase | undefined, status: CompanyStatus | null): boolean {
  return !!(data && item && status?.company && status.member && (status.networkEnabled || status.remoteHost && status.transport === 'encrypted-company') && !status.departurePending && status.hostMode !== 'standby' && status.hostMode !== 'retired' &&
    !data.department.retiredAt && data.department.access === 'write' && item.status === 'open' && !item.needsReview && !item.needsAssignment &&
    item.assignee?.id === status.member.id && item.assignee.active && item.assignee.canWrite);
}
/** Literal reviewed text, never rendered as HTML, links or executable markdown. */
export function DepartmentPreparationReview({ review }: { review:CompanyExecutionReview }) {
  const p = review.plan;
  return <div aria-label="Complete department preparation plan" className="space-y-3 min-w-0">
    <h5 className="font-medium break-words">{p.title}</h5>
    <p className="whitespace-pre-wrap break-words">{p.description}</p>
    <ol className="list-decimal space-y-2 pl-5">{p.steps.map((step,index)=><li className="whitespace-pre-wrap break-words" key={index}>{step}</li>)}</ol>
    <div><p className="font-medium">Evidence to prepare</p><p className="whitespace-pre-wrap break-words">{p.evidence || 'No additional evidence requested.'}</p></div>
    <p>Allowed work: {p.capabilities.map(c=>c==='analyse'?'analyse this case':'draft a result').join(', ')}. Up to {p.limits.maxRuntimeMinutes} minutes and {p.limits.maxTurns} steps of reasoning.</p>
    <p className="text-ink-secondary">No connected account or website access is included. Private workflows require explicitly configured department connectors before they can be used for company work.</p>
    {p.siteNotes !== null && <div><p className="font-medium">Plan notes</p><p className="whitespace-pre-wrap break-words">{p.siteNotes || 'No additional notes.'}</p></div>}
    <div><p className="font-medium">Complete worker instructions</p><pre tabIndex={0} aria-label="Complete worker instructions" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line p-3 font-sans text-[13px]">{review.instructions || 'No additional instructions.'}</pre></div>
  </div>;
}
export function DepartmentPreparationResult({ state }: { state:DepartmentWorkState }) {
  return <div className="space-y-2 min-w-0" aria-label="Saved local preparation result">
    <p className="font-medium">{phases[state.phase]}</p><p className="whitespace-pre-wrap break-words">{state.detail}</p><p className="text-ink-secondary">Last recorded on this instance: {new Date(state.updatedAt).toLocaleString()}</p>
    {state.result && <><p className="font-medium">Recorded result · {state.result.status}</p><p className="whitespace-pre-wrap break-words">{state.result.detail}</p>
      {state.result.outputs.map((output,index)=><pre key={index} tabIndex={0} aria-label={`Complete prepared output ${index+1}`} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line p-3 font-sans text-[13px]">{output}</pre>)}
      {state.result.outputs.length === 0 && <p>No prepared text was recorded.</p>}
      <p className="text-ink-secondary">The case stays under human review. Check the result, then use the existing case review controls to record what happened.</p></>}
  </div>;
}
export function CompanyDepartmentPreparation({ departmentId, cases, operationBlocked = false, onChanged }: {departmentId:string; cases:DepartmentCasePage|null;operationBlocked?:boolean;onChanged?:()=>void}) {
  const id=useId();
  const [status,setStatus]=useState<CompanyStatus|null>(null),[page,setPage]=useState<DepartmentWorkPage|null>(null),[catalog,setCatalog]=useState<DepartmentWorkCatalog|null>(null);
  const [offset,setOffset]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[storageReady,setStorageReady]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [saved,setSaved]=useState<DepartmentPreparationOperation|null>(null),[caseId,setCaseId]=useState(''),[recipeId,setRecipeId]=useState(''),[hours,setHours]=useState('24');
  const [consentSnapshot,setConsentSnapshot]=useState('');
  const [consent,setConsent]=useState(false),[approval,setApproval]=useState<CompanyExecutionGrant|null>(null),[approved,setApproved]=useState(false),[revoking,setRevoking]=useState<CompanyExecutionGrant|null>(null),[note,setNote]=useState('');
  const [now,setNow]=useState(Date.now());
  const active=useRef(true),pending=useRef(false),generation=useRef(0),editing=useRef(false),storageKey=useRef('');
  const clearReview=()=>{setApproval(null);setApproved(false);setRevoking(null);setConsent(false);editing.current=false;};
  const load=useCallback(async()=>{
    const epoch=companyApi.sessionVersion(),current=++generation.current;
    const results=await Promise.allSettled([companyApi.status(),companyApi.departmentPreparations(departmentId,offset),companyApi.departmentPreparationCatalog(departmentId)]);
    if(!active.current || epoch!==companyApi.sessionVersion() || current!==generation.current)return;
    const [person,records,plans]=results;
    if(person.status!=='fulfilled' || !person.value.member || !person.value.company) {setStatus(null);setPage(null);setCatalog(null);setStorageReady(false);throw new Error('Sign in to your company before checking preparations.');}
    const next=person.value;
    setStatus(next);
    const key=`realbud.department-preparation.v1:${next.company!.id}:${next.member!.id}:${departmentId}`;
    try {
      const raw=sessionStorage.getItem(key);
      let operation:DepartmentPreparationOperation|null=null;
      if(raw){const parsed:unknown=JSON.parse(raw);if(!isDepartmentPreparationOperation(parsed)||parsed.departmentId!==departmentId)throw new Error();operation=parsed;}
      storageKey.current=key;setSaved(operation);setStorageReady(true);
    }catch{setStorageReady(false);throw new Error('Saved preparation recovery could not be read. Keep this tab open and contact support before making another request.');}
    if(records.status==='fulfilled'){
      if(records.value.grants.some(g=>g.spec.companyId!==next.company!.id)) {setPage(null);throw new Error('The preparation response belongs to another company. Refresh company status.');}
      setPage(records.value);
    }else{setPage(null);throw records.reason;}
    if(plans.status==='fulfilled')setCatalog(plans.value);else{setCatalog(null);setError('Plans are unavailable. Existing preparation records can still be reviewed; refresh to load the catalog.');}
  },[departmentId,offset]);
  useEffect(()=>{
    active.current=true;setLoading(true);setPage(null);clearReview();
    void load().catch(cause=>{if(active.current)setError(cause instanceof Error?cause.message:'Preparation status is unavailable.');}).finally(()=>{if(active.current)setLoading(false);});
    const stop=companyApi.subscribeSession(()=>{generation.current++;setStatus(null);setPage(null);setCatalog(null);setSaved(null);setStorageReady(false);setLoading(false);storageKey.current='';clearReview();setNotice('');});
    const refresh=()=>{if(!pending.current&&!editing.current)void load().catch(()=>{if(active.current){setPage(null);setError('Preparation status could not be refreshed. Check the host connection.');}});};
    const timer=setInterval(()=>{setNow(Date.now());refresh();},15000);window.addEventListener('focus',refresh);
    return()=>{active.current=false;generation.current++;stop();clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[load]);
  async function refresh(){if(pending.current)return;pending.current=true;setBusy(true);setError('');clearReview();try{await load();}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'Could not refresh preparations.');}finally{pending.current=false;if(active.current)setBusy(false);}}
  async function mutate(operation:DepartmentPreparationOperation){
    if(pending.current||!storageReady||!status?.member||!status.company||operation.departmentId!==departmentId)return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    const epoch=companyApi.sessionVersion(),key=storageKey.current;
    try{
      if(!isDepartmentPreparationOperation(operation))throw new Error('Check the preparation fields before continuing.');
      sessionStorage.setItem(key,JSON.stringify(operation));setSaved(operation);
      const response=operation.kind==='prepare'?await companyApi.prepareDepartmentWork(operation.input):operation.kind==='confirm'?await companyApi.confirmDepartmentPreparation(operation.input):operation.kind==='revoke'?await companyApi.revokeDepartmentPreparation(operation.input):await companyApi.reconcileDepartmentPreparation(operation.input.grantId);
      if(!active.current||epoch!==companyApi.sessionVersion())return;
      if(operation.kind==='prepare'&&'grant' in response&&(response.grant.spec.companyId!==status.company.id||response.grant.spec.memberId!==status.member.id))throw new Error('Preparation identity changed. Refresh company status before continuing.');
      if((operation.kind==='confirm'||operation.kind==='revoke')&&'spec' in response&&(response.spec.companyId!==status.company.id||response.spec.departmentId!==departmentId))throw new Error('Preparation scope changed. Refresh before making another decision.');
      sessionStorage.removeItem(key);setSaved(null);clearReview();setCaseId('');setRecipeId('');
      setNotice(operation.kind==='prepare'?'Preparation requested. It will wait for owner approval before starting on your assigned RealBud instance.':operation.kind==='confirm'?'Approval recorded. The assigned instance will check permission and prepare this case when available.':operation.kind==='revoke'?'Preparation permission withdrawn. Review any result already produced before deciding what to do next.':'Saved result delivery was checked. This did not repeat the preparation.');
      await load();onChanged?.();
    }catch(cause){
      if(active.current&&epoch===companyApi.sessionVersion()){
        // A definitive reply still requires a current persisted-state check before a fresh decision.
        if(!departmentMutationUncertain(cause)){try{await load();sessionStorage.removeItem(key);setSaved(null);clearReview();}catch{/* Keep the original exact operation until its state can be checked. */}}
        setError(cause instanceof Error?cause.message:'The reply did not arrive. Retry the saved request to check its result.');
      }
    }finally{pending.current=false;if(active.current)setBusy(false);}
  }
  const selectedCase=cases?.cases.find(item=>item.id===caseId),selectedRecipe=catalog?.recipes.find(r=>r.id===recipeId);
  const consentKey=selectedCase&&selectedRecipe&&cases?canonicalWebsiteCommand({case:selectedCase,department:cases.department,recipe:selectedRecipe,hours}):'';
  const hasConsent=consent&&!!consentKey&&consentSnapshot===consentKey;
  const blocked=busy||loading||operationBlocked||!!saved||!storageReady||!status?.member||!page;
  const alreadyRequested=(targetCaseId:string)=>!!page?.grants.some(g=>g.spec.caseId===targetCaseId&&g.current&&g.phase!=='revoked')||!!page?.local.some(s=>s.caseId===targetCaseId&&s.phase==='requesting');
  const availableCases=cases?.cases.filter(item=>canRequestDepartmentPreparation(cases,item,status)&&!alreadyRequested(item.id))??[];
  const orphan=page?.local.filter(s=>!page.grants.some(g=>g.id===s.grantId))??[];
  const localFor=(grantId:string)=>page?.local.find(s=>s.grantId===grantId);
  const recover=(state:DepartmentWorkState)=><div className="space-y-2">
    {state.phase==='requesting'&&<><p>This instance saved the request before contacting the host. Check that same request to recover its outcome.</p><button className={button} disabled={blocked} onClick={()=>void mutate({kind:'prepare',departmentId,input:state.request})}>Retry original preparation request</button></>}
    {state.phase==='held'&&state.result&&<><p>Retrying delivery sends this saved result only. It cannot restart the worker or mark the case completed.</p><button className={button} disabled={blocked} onClick={()=>void mutate({kind:'reconcile',departmentId,input:{grantId:state.grantId}})}>Retry saved result delivery</button></>}
  </div>;
  return <section aria-label="Department preparation" className="min-w-0 space-y-4 border-t border-line pt-4 sm:rounded-lg sm:border sm:p-4" aria-busy={loading||busy}>
    <div><p className="text-[12px] uppercase tracking-wide text-ink-secondary">Assigned case preparation</p><h4 className="mt-1 font-medium">Review once, prepare one case</h4></div>
    <p>Ask RealBud to analyse an assigned case or draft a result. The member requests the exact plan, then the company owner reviews and approves it. The assigned instance can start after approval. Sending messages, submitting forms and using private connected accounts are outside this permission.</p>
    {status&&!status.networkEnabled&&!status.remoteHost&&<p className="rounded-lg border border-line p-3">Enable office joining in Company connection settings before requesting preparation. A current encrypted host identity is required, including for a solo office.</p>}
    {error&&<p role="alert" className="text-danger">{error}</p>}{notice&&<p role="status" className="text-ink-secondary">{notice}</p>}
    {saved&&<div className="rounded-lg border border-hold p-3 space-y-2"><h5 className="font-medium">Saved request needs confirmation</h5><p>The last {saved.kind==='prepare'?'preparation request':saved.kind==='confirm'?'approval':saved.kind==='revoke'?'withdrawal':'result delivery'} may already be recorded. Retry sends its original details and operation ID.</p><button className={button} disabled={busy||!storageReady||operationBlocked} onClick={()=>void mutate(saved)}>Check saved preparation request</button></div>}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>void refresh()}>Refresh preparations</button><span role="status" className="self-center text-ink-secondary">{loading?'Loading preparations…':status?.member?`Company member: ${status.member.displayName}`:'Company sign-in required'}</span></div>
    <details onToggle={event=>{if(!approval&&!revoking)editing.current=event.currentTarget.open;}} className="rounded-lg border border-line p-3">
      <summary className="min-h-11 cursor-pointer content-center font-medium">Request preparation for my assigned case</summary>
      <form className="mt-3 space-y-3" onSubmit={event=>{event.preventDefault();if(blocked||!hasConsent||!selectedRecipe||!selectedCase||alreadyRequested(selectedCase.id)||!canRequestDepartmentPreparation(cases,selectedCase,status)||!cases)return;void mutate({kind:'prepare',departmentId,input:{version:1,requestId:crypto.randomUUID(),departmentId,expectedDepartmentRevision:cases.department.revision,caseId:selectedCase.id,expectedCaseFence:selectedCase.fence,recipeId:selectedRecipe.id,expectedRecipeRevision:selectedRecipe.revision,durationMs:Number(hours)*3600000}});}}>
        <label className="block space-y-1"><span id={`${id}-case-label`}>Open case assigned to me</span><select aria-labelledby={`${id}-case-label`} className={field} disabled={blocked} value={caseId} onChange={event=>{setCaseId(event.target.value);setConsent(false);}}><option value="">Select an assigned case…</option>{availableCases.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {availableCases.length===0&&<p className="text-ink-secondary">No eligible case on the current case page. You need an open case assigned to your signed-in member with current editing access. Use All work or another case page to find it.</p>}
        {selectedCase&&<div className="rounded-lg border border-line p-3"><h5 className="font-medium break-words">{selectedCase.title}</h5><p className="whitespace-pre-wrap break-words">{selectedCase.description||'No additional case description.'}</p></div>}
        <label className="block space-y-1"><span id={`${id}-plan-label`}>Reviewed preparation plan</span><select aria-labelledby={`${id}-plan-label`} className={field} disabled={blocked||!catalog} value={recipeId} onChange={event=>{setRecipeId(event.target.value);setConsent(false);}}><option value="">Select a plan…</option>{catalog?.recipes.map(recipe=><option key={recipe.id} value={recipe.id}>{recipe.title} · version {recipe.revision}</option>)}</select></label>
        {catalog?.recipes.length===0&&<p>No eligible analysis or drafting plan is available. Ask your service administrator to prepare one for department use.</p>}
        {selectedRecipe&&<DepartmentPreparationReview review={selectedRecipe.review}/>}
        <label className="block space-y-1"><span id={`${id}-expiry-label`}>Permission expiry after request</span><select aria-labelledby={`${id}-expiry-label`} className={field} disabled={blocked} value={hours} onChange={event=>{setHours(event.target.value);setConsent(false);}}><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option></select></label>
        <p className="text-ink-secondary">This allows one preparation, not recurring work. The owner will see the exact expiry before approving. Keep your assigned RealBud instance available.</p>
        <label className="flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={hasConsent} disabled={blocked} onChange={event=>{setConsentSnapshot(consentKey);setConsent(event.target.checked);}}/><span>I reviewed the complete plan and case. I request one preparation on my assigned instance after the owner approves.</span></label>
        <button className={button} disabled={blocked||!hasConsent||!selectedRecipe||!!selectedCase&&alreadyRequested(selectedCase.id)||!canRequestDepartmentPreparation(cases,selectedCase,status)}>Request one preparation</button>
      </form>
    </details>
    {page&&page.grants.length===0&&<p>No preparation requests on this page.</p>}
    {page?.grants.map(grant=>{const state=localFor(grant.id);return <article key={grant.id} aria-label={`Preparation for ${grant.source.title}`} className="min-w-0 space-y-3 rounded-lg border border-line p-3">
      <h5 className="font-medium break-words">{grant.source.title}</h5><p>{grant.phase==='revoked'?'Permission withdrawn':state?phases[state.phase]:!grant.current?'Permission needs attention':grant.phase==='pending'?'Waiting for owner approval':grant.phase==='admitted'?'Preparation started on the assigned instance; check its result':'Approved; waiting for assigned instance'}</p>
      <p className="break-words">Requested by {grant.memberName} · {grant.departmentName}</p><p>Permission expires {new Date(grant.expiresAt).toLocaleString()}.</p>
      <details><summary className="min-h-11 cursor-pointer content-center">Review case, plan and instance</summary><div className="space-y-3"><p className="whitespace-pre-wrap break-words">{grant.source.description||'No additional case description.'}</p>{grant.spec.recipe.review?<DepartmentPreparationReview review={grant.spec.recipe.review}/>:<p role="status">This older request has no complete reviewed plan and cannot start department preparation.</p>}<p className="break-all text-ink-secondary">Assigned RealBud instance: {grant.spec.executor.workspaceId}</p></div></details>
      {state?<><DepartmentPreparationResult state={state}/>{recover(state)}</>:<p className="text-ink-secondary">Local results are shown only on the requesting member’s saved instance. Ask the assigned member to review its recorded result.</p>}
      <div className="flex flex-wrap gap-2">{page.canManage&&status?.member?.role==='owner'&&grant.phase==='pending'&&grant.current&&grant.spec.recipe.review&&Date.parse(grant.expiresAt)>now&&<button className={button} disabled={blocked} onClick={()=>{editing.current=true;setApproval(grant);setApproved(false);setRevoking(null);}}>Review and approve preparation</button>}
        {grant.phase!=='revoked'&&(page.canManage||grant.spec.memberId===status?.member?.id)&&<button className={button} disabled={blocked} onClick={()=>{editing.current=true;setRevoking(grant);setNote('');setApproval(null);}}>Review withdrawal</button>}</div>
    </article>;})}
    {orphan.map(state=><article key={state.grantId} className="min-w-0 space-y-3 rounded-lg border border-hold p-3"><h5 className="font-medium">Saved instance request</h5><p className="break-all text-ink-secondary">Case reference: {state.caseId}</p><DepartmentPreparationResult state={state}/>{recover(state)}{state.phase!=='requesting'&&!state.result&&<p>Refresh to check the host permission. This record cannot create replacement authority automatically.</p>}</article>)}
    {page&&(offset>0||page.hasMore)&&<div className="flex flex-wrap gap-2"><button className={button} disabled={busy||!!approval||!!revoking||offset===0} onClick={()=>setOffset(n=>Math.max(0,n-10))}>Previous preparations</button><button className={button} disabled={busy||!!approval||!!revoking||!page.hasMore} onClick={()=>setOffset(n=>n+10)}>More preparations</button></div>}
    {approval&&<form aria-label="Owner approval of department preparation" className="space-y-3 rounded-lg border border-agency p-3" onSubmit={event=>{event.preventDefault();if(!approved||Date.parse(approval.expiresAt)<=Date.now()||blocked||!page?.canManage||status?.member?.role!=='owner'||!approval.spec.recipe.review)return;void mutate({kind:'confirm',departmentId,input:{version:1,requestId:crypto.randomUUID(),grantId:approval.id,expectedRevision:approval.revision,grantDigest:approval.digest}});}}>
      <h5 className="font-medium">Owner review · {approval.source.title}</h5><p className="break-words">Member: {approval.memberName} · Department: {approval.departmentName}</p><p className="whitespace-pre-wrap break-words">{approval.source.description||'No additional case description.'}</p>
      {approval.spec.recipe.review&&<DepartmentPreparationReview review={approval.spec.recipe.review}/>}
      <p className="break-all">Assigned RealBud instance: {approval.spec.executor.workspaceId}</p><p>Permission expires {new Date(approval.expiresAt).toLocaleString()}.</p>
      <label className="flex min-h-11 items-start gap-2"><input type="checkbox" checked={approved} disabled={blocked} onChange={event=>setApproved(event.target.checked)}/><span>I reviewed this exact member, case, instance, plan and instructions. I approve one preparation, which may start on the assigned instance after confirmation.</span></label>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={blocked||!approved||Date.parse(approval.expiresAt)<=now}>Approve one preparation</button><button type="button" className={button} disabled={busy} onClick={clearReview}>Keep waiting</button></div>
    </form>}
    {revoking&&<form aria-label="Withdraw department preparation permission" className="space-y-3 rounded-lg border border-hold p-3" onSubmit={event=>{event.preventDefault();if(blocked||!note.trim())return;void mutate({kind:'revoke',departmentId,input:{version:1,requestId:crypto.randomUUID(),grantId:revoking.id,expectedRevision:revoking.revision,note:note.trim()}});}}>
      <h5 className="font-medium break-words">Withdraw permission · {revoking.source.title}</h5><p>This stops further authorized preparation. It does not erase a result already produced. Review the case before deciding whether new work is safe.</p><label htmlFor={`${id}-withdraw-note`}>Reason for withdrawal</label><textarea id={`${id}-withdraw-note`} className={field} required maxLength={2048} value={note} disabled={blocked} onChange={event=>setNote(event.target.value)}/><div className="flex flex-wrap gap-2"><button className={button} disabled={blocked||!note.trim()}>Withdraw preparation permission</button><button type="button" className={button} disabled={busy} onClick={clearReview}>Keep permission</button></div>
    </form>}
  </section>;
}
