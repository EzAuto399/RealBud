import {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '@/state/store';
import {Card} from '../SettingsPrimitives';
import type {RemoteWorkStatus, RemoteWorkList, RemoteWorkView} from '../../../server/website-remote-work';
import type {RemoteApproversStatus} from '../../../server/website-remote-approvers';
import type {WebsiteCommandPhase} from '@shared/website-commands';

type Snapshot = RemoteWorkList & {status:RemoteWorkStatus};
const button='pm-control min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const terminal=(phase:WebsiteCommandPhase)=>['completed','needs-review','partial','failed','interrupted','rejected','cancelled','expired','stale'].includes(phase);
const date=(value:string)=>new Date(value).toLocaleString();
const phases:Record<WebsiteCommandPhase,string>={queued:'Waiting for computer review',delivered:'Waiting for a website decision',accepted:'Approved · checking start',running:'Preparing on this computer',completed:'Preparation complete','needs-review':'Result needs local review',partial:'Partial result · check locally',failed:'Preparation failed',interrupted:'Interrupted · check saved outcome',rejected:'Review rejected',cancelled:'Cancelled',expired:'Expired',stale:'Work changed · new review needed'};
function stateLabel(row:RemoteWorkView){
  if(row.cancellationPending)return 'Waiting for cancellation confirmation';
  if(row.cancellationRequested&&!terminal(row.phase))return 'Cancellation requested · checking outcome';
  if(row.sharingPending)return 'Waiting for review-sharing confirmation';
  if((row.phase==='queued'||row.phase==='delivered')&&row.review?.decision?.choice==='approve')return 'Approved · waiting for this computer';
  return phases[row.phase];
}
function enrollmentKey(value:RemoteApproversStatus|null){
  if(!value)return '';
  return JSON.stringify({enabled:value.enabled,parent:value.grant,scopes:value.scopes,people:value.enrollments.filter(row=>row.phase==='confirmed').map(row=>({id:row.id,approver:row.approver}))});
}

export function RemoteWorkCard(){
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[enrollment,setEnrollment]=useState<RemoteApproversStatus|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [consent,setConsent]=useState(''),[disableConfirm,setDisableConfirm]=useState(false),[cancel,setCancel]=useState<{id:string;revision:number}|null>(null);
  const [history,setHistory]=useState(false);
  const running=useRef(false),alive=useRef(true),latest=useRef<Snapshot|null>(null);
  const refresh=useCallback(async(older=false,preserveHistory=false)=>{
    const previous=latest.current;
    const before=older?previous?.next:null;
    if(older&&before==null)return;
    const result:Snapshot=await api(`/api/website-requests/remote-work${before==null?'':`?before=${encodeURIComponent(before)}`}`);
    const parent:RemoteApproversStatus=await api('/api/website-requests/remote');
    if(!alive.current)return;
    const next=older&&previous?{...result,records:[...previous.records.filter(row=>!result.records.some(fresh=>fresh.id===row.id)),...result.records]}
      :preserveHistory&&previous?{...result,next:previous.next,records:[...result.records,...previous.records.filter(row=>!result.records.some(fresh=>fresh.id===row.id))]}:result;
    latest.current=next;setSnapshot(next);setEnrollment(parent);
  },[]);
  const poll=useCallback(async()=>{
    if(running.current)return;running.current=true;setBusy('refresh');
    try{await refresh(false,true);}catch{if(alive.current)setError('Saved remote work status could not be loaded. Refresh before changing permissions.');}
    finally{running.current=false;if(alive.current)setBusy(null);}
  },[refresh]);
  useEffect(()=>{
    alive.current=true;const initial=setTimeout(()=>{void poll();},0);
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void poll();},15_000);
    const linked=()=>{void poll();};window.addEventListener('realbud-website-link-changed',linked);
    return()=>{alive.current=false;clearTimeout(initial);clearInterval(timer);window.removeEventListener('realbud-website-link-changed',linked);};
  },[poll]);
  const perform=async(name:string,work:()=>Promise<unknown>,message:string,older=false)=>{
    if(running.current)return;running.current=true;setBusy(name);setError('');setNotice('');
    try{await work();await refresh(older);if(alive.current){setNotice(message);setConsent('');setCancel(null);setDisableConfirm(false);}}
    catch(cause){if(alive.current){setConsent('');setCancel(null);setError(`${cause instanceof Error?cause.message:'This action could not be confirmed.'} Refresh saved status before retrying; the earlier action may have completed.`);try{await refresh();}catch{/* Keep the saved view and uncertain-outcome notice. */}}}
    finally{running.current=false;if(alive.current)setBusy(null);}
  };
  const post=(action:string,body:unknown={})=>api(`/api/website-requests/remote-work/${action}`,{method:'POST',body:JSON.stringify(body)},{timeoutMs:45_000});
  const status=snapshot?.status,localWorking=!!busy,working=localWorking||!!status?.busy;
  const key=enrollmentKey(enrollment);
  const people=enrollment?.enrollments.filter(row=>row.phase==='confirmed')??[];
  const descriptors=status?.enabled?status.descriptors:enrollment?.grant?.descriptors.filter(descriptor=>enrollment.scopes.some(scope=>scope.descriptorId===descriptor.id&&scope.descriptorRevision===descriptor.revision))??[];
  const canEnable=!!status&&!status.enabled&&!!enrollment?.enabled&&!enrollment.pending&&!!enrollment.grant&&!enrollment.grant.revokedAt&&people.length>0&&descriptors.length>0&&status.pendingCancellations===0;
  const activeRows=snapshot?.records.filter(row=>!row.restored&&!terminal(row.phase))??[];
  const historyRows=snapshot?.records.filter(row=>row.restored||terminal(row.phase))??[];
  function requestRow(row:RemoteWorkView){
    const confirm=cancel?.id===row.id&&cancel.revision===row.revision;
    return <li key={row.id} className="min-w-0 space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><h5 className="min-w-0 break-words font-medium">{row.descriptor.label}</h5><span className="rounded bg-raised px-2 py-1 text-xs">{stateLabel(row)}</span></div>
      <p className="text-xs text-ink-muted">Requested {date(row.createdAt)} · permission expires {date(row.expiresAt)}</p>
      {row.restored&&<p className="text-hold">Restored history only. Previous decisions and pending work cannot run on this computer.</p>}
      {row.sharingPending&&<p role="status" className="text-hold">The website has not confirmed this exact review upload. RealBud keeps the saved review for reconciliation; this is not permission to start work.</p>}
      {row.cancellationPending&&<p role="status" className="text-hold">A stop was requested locally. Website confirmation is pending; preparation already running may still finish. Check the saved outcome before making another request.</p>}
      {row.cancellationRequested&&!row.cancellationPending&&!terminal(row.phase)&&<p role="status" className="text-hold">Cancellation is recorded. Work was already underway; wait for the computer’s confirmed stop or saved result before requesting it again.</p>}
      {row.review?.decision&&<p className="break-words text-ink-secondary">{row.review.decision.choice==='approve'?'Approved':'Rejected'} by {row.review.decision.person.email} · {date(row.review.decision.decidedAt)}.</p>}
      {row.review?.prunedAt&&<p className="text-xs text-ink-muted">The website removed the shared review text under its retention policy. Saved local history remains.</p>}
      {['completed','needs-review','partial'].includes(row.phase)&&<p className="text-ink-secondary">Open the relevant workspace here to inspect the prepared result. Preparation does not mean anything was sent, paid or submitted.</p>}
      {row.phase==='interrupted'&&<p className="text-hold">Check the existing run and saved outcome before requesting more work. This card does not automatically resubmit interrupted preparation.</p>}
      {!row.restored&&!terminal(row.phase)&&!row.cancellationPending&&!row.cancellationRequested&&(confirm?<div className="space-y-3 rounded border border-line p-3"><p>Cancel this exact request? Preparation already running may still finish; RealBud requests a stop where supported and keeps the saved result.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={localWorking} onClick={()=>void perform('cancel',()=>post('cancel',{id:row.id,expectedRevision:row.revision}),'Cancellation was requested. Follow its confirmed status below.')}>Confirm cancellation</button><button type="button" className={button} disabled={localWorking} onClick={()=>setCancel(null)}>Keep request</button></div></div>:<button type="button" className={button} disabled={localWorking} onClick={()=>setCancel({id:row.id,revision:row.revision})}>Cancel this request</button>)}
    </li>;
  }
  return <Card title="Shared reviews and remote preparation" subtitle="Off until you enable it here. Workspace enrollment alone does not share a review or start work.">
    <div className="space-y-4 text-sm">
      <p className="text-ink-secondary">When enabled, this computer may share the complete templates you already reviewed with their confirmed audience. An invited person can request a preparation and approve or reject its exact review on the website. RealBud rechecks the plan, sources and permissions before preparing work.</p>
      {!snapshot?<p role="status">Loading saved sharing settings…</p>:<>
        <div className="space-y-2 rounded-lg bg-raised p-3"><p className="font-medium">{status?.workspaceLabel??enrollment?.workspaceLabel??'This workspace'}</p><p role="status">{status?.enabled?status.ready?'Sharing enabled · approved preparation may run':'Sharing enabled · work is on hold':'Sharing and remote preparation are off'}</p><p className="text-xs text-ink-muted">Results and private execution details stay on this computer. The website receives the reviewed plan, addressed people, decisions and progress.</p></div>
        {!!status?.error&&<p role="status" className="rounded-lg border border-line p-3 text-hold">{status.error}</p>}
        {!!status?.pendingCancellations&&<p role="status" className="text-hold">{status.pendingCancellations} {status.pendingCancellations===1?'cancellation is':'cancellations are'} waiting for website confirmation. Keep the original workspace link and check again when the website is available.</p>}
        {descriptors.length>0&&<section className="space-y-2" aria-label="Reviewed work eligible for sharing"><h4 className="font-medium">Reviewed preparations</h4><ul className="list-disc space-y-1 pl-5">{descriptors.map(descriptor=><li key={descriptor.id} className="break-words">{descriptor.label}</li>)}</ul></section>}
        {!status?.enabled&&<div className="space-y-3">
          {!canEnable?<p className="text-hold">Confirm an invited person and the intended reviewed work in Workspace access above, resolve any source or permission hold, and finish pending cancellations before enabling sharing.</p>:<>
            <p className="break-words">Confirmed people: {people.map(row=>row.candidate?.email??'Verified person').join(', ')}. Each shared review is limited to its exact eligible audience.</p>
            <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1" disabled={working} checked={consent===key} onChange={event=>setConsent(event.target.checked?key:'')}/><span>I allow sharing the already reviewed templates for the preparations above with their confirmed audience, and allow the computer to prepare work after an eligible person approves its exact review.</span></label>
            <button type="button" className={`${button} border-agency`} disabled={working||consent!==key} onClick={()=>void perform('enable',async()=>{const fresh:RemoteApproversStatus=await api('/api/website-requests/remote');if(enrollmentKey(fresh)!==consent)throw new Error('Workspace access changed. Refresh and review the current people and preparations.');await post('enable');},'Sharing is enabled. Each preparation still requires an eligible person’s exact review decision.')}>Enable shared reviews and approved preparation</button>
          </>}
        </div>}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working} onClick={()=>void perform('sync',()=>post('sync'),'Website work and saved outcomes were checked.')}>{busy==='sync'?'Checking…':'Check website work'}</button>{status?.enabled&&<button type="button" className={button} disabled={localWorking} onClick={()=>setDisableConfirm(true)}>Turn off sharing and remote preparation</button>}</div>
        {disableConfirm&&<div className="space-y-3 rounded-lg border border-line p-3"><p>Turn this off for the workspace? New sharing and starts are blocked locally, even if the website is offline. RealBud will request cancellation for pending work. Preparation already running may still finish; saved history and results remain.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={localWorking} onClick={()=>void perform('disable',()=>post('disable'),'Sharing is off locally. Check any outstanding cancellation confirmations below.')}>Confirm turn off</button><button type="button" className={button} disabled={localWorking} onClick={()=>setDisableConfirm(false)}>Keep current setting</button></div></div>}
        <section className="space-y-3" aria-label="Remote work in progress"><h4 className="font-medium">Requests and preparation</h4>{activeRows.length?<ul className="space-y-3">{activeRows.map(requestRow)}</ul>:<p className="text-ink-secondary">No active requests in the loaded history.</p>}</section>
        <section className="space-y-3" aria-label="Remote preparation history"><button type="button" className={button} aria-expanded={history} onClick={()=>setHistory(value=>!value)}>{history?'Hide':'Show'} completed and restored history ({historyRows.length})</button>{history&&(historyRows.length?<ul className="space-y-3">{historyRows.map(requestRow)}</ul>:<p className="text-ink-secondary">No completed or restored requests in the loaded history.</p>)}{snapshot.next!=null&&<button type="button" className={button} disabled={working} onClick={()=>void perform('history',async()=>{},'Older history loaded.',true)}>Load older work</button>}</section>
      </>}
      {error&&<p role="alert" className="break-words text-hold">{error}</p>}
      {notice&&<p role="status" aria-live="polite" className="text-ink-secondary">{notice}</p>}
      <button type="button" className={button} disabled={working} onClick={()=>void perform('refresh',async()=>{},'Saved remote work status refreshed.')}>Refresh saved sharing status</button>
      <p className="text-xs text-ink-muted">Turning on sharing does not authorize outgoing messages, payments, bank posting or new schedules. Those actions keep their own approval controls.</p>
    </div>
  </Card>;
}
