import { useCallback, useEffect, useState } from 'react';
import { api } from '@/state/store';
import { Card } from '../SettingsPrimitives';
import type { RemoteApproversStatus, RemoteEnrollmentView } from '../../../server/website-remote-approvers';
import type { RemoteTemplateRecord } from '../../../server/website-remote-disclosure';
import type { WorkflowRecord } from '../../../server/workflow-database';
import type { WebsiteCommandDescriptor } from '@shared/website-commands';
import type { RemoteApproverScope } from '@shared/website-remote-approvers';
const button='pm-control min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const phaseLabel:Record<string,string>={publishing:'Waiting for the website',pending:'Waiting for sign-in',candidate:'Review this person',confirmed:'Person confirmed',revoking:'Waiting for revocation confirmation',revoked:'Access revoked',expired:'Expired',stale:'Needs attention',disabled:'Disabled'};
const post=(action:string,body:unknown={})=>api(`/api/website-requests/remote/${action}`,{method:'POST',body:JSON.stringify(body)},{timeoutMs:45_000});
function Candidate({row,busy,confirm}:{row:RemoteEnrollmentView;busy:boolean;confirm:()=>void}){
 const [checked,setChecked]=useState(false);
 return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="Confirm invited person">
  <p><strong>{row.candidate?.email}</strong> · {row.candidate?.agencyLabel}</p>
  <p className="text-ink-secondary">Verify this person and this workspace before confirming. Their permission expires {new Date(row.approverExpiresAt).toLocaleString()}. Each preparation still needs a separate review and approval.</p>
  <label className="flex items-start gap-2"><input type="checkbox" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/><span>This is the person I intend to give access to the reviewed work listed above.</span></label>
  <button className={button} disabled={busy||!checked} onClick={confirm}>Confirm this person</button>
 </section>;
}
export function RemoteApproversCard(){
 const [status,setStatus]=useState<RemoteApproversStatus|null>(null),[catalog,setCatalog]=useState<WebsiteCommandDescriptor[]>([]),[localEnabled,setLocalEnabled]=useState(false);
 const [selected,setSelected]=useState<string[]>([]),[label,setLabel]=useState('My workspace'),[alias,setAlias]=useState('Accounts mailbox');
 const [reviews,setReviews]=useState<WorkflowRecord<RemoteTemplateRecord>[]>([]),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [challenge,setChallenge]=useState<{enrollmentId:string;secret:string;expiresAt:string}|null>(null),[disableConfirm,setDisableConfirm]=useState(false);
 const load=useCallback(async()=>{const [remote,local]=await Promise.all([api('/api/website-requests/remote'),api('/api/website-requests')]);setStatus(remote);setCatalog(local.status.catalog);setLocalEnabled(local.status.enabled);},[]);
 useEffect(()=>{let active=true;void load().catch(()=>{if(active)setError('Workspace access could not be refreshed. Existing permissions are unchanged.');});return()=>{active=false;};},[load]);
 const perform=async(work:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await work();await load();}catch(e){setError(`${e instanceof Error?e.message:'The update could not be confirmed.'} Refresh the saved state before retrying.`);try{await load();}catch{/* Preserve last saved view. */}}finally{setBusy(false);setConsent(false);}};
 const reset=()=>{setReviews([]);setConsent(false);setChallenge(null);};
 const invite=async()=>{
  const scopes:RemoteApproverScope[]=await post('approve-disclosure',{reviews:reviews.map(r=>({id:r.id,revision:r.revision,digest:r.value.digest}))});
  await post('prepare',{descriptorIds:selected,label:label.trim(),scopes});
  const result=await post('begin',{scopes});setChallenge(result.challenge);setReviews([]);
 };
 return <Card title="People who can review from the website" subtitle="Invite a verified person, then confirm them here. Linking a computer or owning the billing account does not give this permission.">
  <div className="space-y-4 text-sm">
   <p className="text-ink-secondary">Review the complete plan below before creating an invitation. This setup stores permission records on the RealBud website; it sends no plan text, reads no mailbox and starts no work. Remote preparation approval is a separate step.</p>
   {error&&<p role="alert" className="text-hold">{error}</p>}
   {status?.error&&status.error!==error&&<p role="status" className="rounded-lg border border-line p-3 text-hold">{status.error}</p>}
   <button className={button} disabled={busy} onClick={()=>void perform(async()=>{await post('sync');})}>Refresh access</button>
   {localEnabled&&<div className="space-y-2 rounded-lg border border-line p-3"><p>Turn off the current website request permission before moving this workspace to the new access controls. Older RealBud versions will then hold website requests for this workspace.</p><label className="flex gap-2"><input type="checkbox" checked={disableConfirm} onChange={e=>setDisableConfirm(e.target.checked)}/><span>I want to disable the current website request permission.</span></label><button className={button} disabled={busy||!disableConfirm} onClick={()=>void perform(async()=>{await api('/api/website-requests/disable',{method:'POST',body:'{}'});setDisableConfirm(false);})}>Disable current requests</button></div>}
   {status&&!status.enabled&&!status.pending&&!localEnabled&&(!status.remoteMode||!!status.grant?.revokedAt)&&<div className="space-y-3">
    <label className="block">Workspace name<input className="pm-control mt-1 block w-full rounded-lg border border-line p-2" value={label} maxLength={80} onChange={e=>{setLabel(e.target.value);reset();}}/></label>
    <fieldset className="space-y-2"><legend className="mb-2 font-medium">Preparations this person may review</legend>{catalog.map(d=><label key={d.id} className="flex gap-2"><input type="checkbox" checked={selected.includes(d.id)} onChange={e=>{setSelected(s=>e.target.checked?[...s,d.id]:s.filter(id=>id!==d.id));reset();}}/><span>{d.label}</span></label>)}</fieldset>
    {selected.some(id=>catalog.find(d=>d.id===id)?.operation==='morning-review')&&<label className="block">Mailbox name for the reviewer<input className="pm-control mt-1 block w-full rounded-lg border border-line p-2" value={alias} maxLength={80} onChange={e=>{setAlias(e.target.value);reset();}}/></label>}
    <button className={button} disabled={busy||!selected.length||!label.trim()} onClick={()=>void perform(async()=>{setReviews(await post('preview',{descriptorIds:selected,mailboxAlias:alias.trim()||null}));})}>Review what may be shared</button>
   </div>}
   {reviews.length>0&&<section className="space-y-4 rounded-lg border border-agency p-4" aria-label="Review disclosure template">
    <p className="font-medium">Complete proposed review content</p>
    {reviews.map(r=><div key={r.id} className="space-y-3"><h5 className="font-medium">{r.value.template.descriptor.label}</h5><dl className="space-y-3">{r.value.template.sections.map((s,i)=><div key={i}><dt className="font-medium">{s.label}</dt><dd className="whitespace-pre-wrap break-words text-ink-secondary [overflow-wrap:anywhere]">{s.value}</dd></div>)}</dl></div>)}
    <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/><span>I reviewed all of this text and permit the invited person to see it when I enable remote review. It contains no passwords, provider keys or customer records that should stay private. I understand older RealBud versions cannot manage this upgraded workspace permission.</span></label>
    <button className={button} disabled={busy||!consent||localEnabled||!!status?.remoteMode&&!status.enabled&&!status.grant?.revokedAt} onClick={()=>void perform(invite)}>Create invitation</button>
   </section>}
   {status?.remoteMode&&!status.grant?.revokedAt&&<section className="space-y-2"><p className="font-medium">{status.workspaceLabel}</p><ul className="list-disc pl-5">{status.grant?.descriptors.map(d=><li key={d.id}>{d.label}</li>)}</ul><p className="text-ink-secondary">Only these reviewed plan versions are enrolled. A plan or source change requires a new review.</p><button className={button} disabled={busy||status.pending||!status.enabled} onClick={()=>void perform(async()=>{const result=await post('begin',{scopes:status.scopes});setChallenge(result.challenge);})}>Invite another person</button></section>}
   {challenge&&<section className="space-y-2 rounded-lg border border-agency p-4" aria-label="Invitation code"><p>Give this code to the intended person. They sign in at <a className="underline" href="https://realbud.app/account/remote-approvers" target="_blank" rel="noreferrer">RealBud workspace access</a>, then paste it there. You must still confirm them on this computer.</p><input aria-label="Invitation code" readOnly className="pm-control block w-full rounded-lg border border-line p-2 font-mono" value={`${challenge.enrollmentId}.${challenge.secret}`}/><p>Expires {new Date(challenge.expiresAt).toLocaleString()}. Do not put the code in public notes.</p><button className={button} onClick={()=>setChallenge(null)}>Hide code</button></section>}
   {status?.enrollments.map(row=><div key={row.id} className="space-y-2 border-t border-line pt-4"><p>{row.candidate?.email??'Waiting for the invited person'} · <strong>{phaseLabel[row.phase]??'Refresh this connection'}</strong></p>{row.phase==='candidate'&&<Candidate key={`${row.id}:${row.revision}:${row.candidateDigest}`} row={row} busy={busy} confirm={()=>void perform(async()=>{await post('confirm',{enrollmentId:row.id,expectedRevision:row.revision,candidateDigest:row.candidateDigest});setChallenge(null);})}/>} {!['revoked','disabled','expired'].includes(row.phase)&&<button className={button} disabled={busy} onClick={()=>void perform(async()=>{await post('revoke',{enrollmentId:row.id});setChallenge(null);})}>Revoke invitation or access</button>}</div>)}
   {status?.remoteMode&&(!status.grant?.revokedAt||status.enabled)&&<button className={button} disabled={busy} onClick={()=>void perform(async()=>{await post('disable');setChallenge(null);})}>Disable all remote access here</button>}
  </div>
 </Card>;
}
