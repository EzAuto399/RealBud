import { useEffect, useRef, useState } from 'react';
import type { CustomerPack, CustomerPackInstallation, CustomerPackPreview, CustomerPackChangePreview } from '@shared/customer-packs';
import { api } from '@/state/store';
import { PackSkillReview, type PackSkillReviewState } from './PackSkillReview';
import { CustomerPackChangeReview } from './CustomerPackChangeReview';
import { CustomerPackHistory } from './CustomerPackHistory';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const labels = { passed: 'Checked', needed: 'Needs setup', unknown: 'Not verified' };
export function CustomerPackSetupCard({ onInstalled }: { onInstalled?: () => void | Promise<void> }) {
  const [installed, setInstalled] = useState<CustomerPackInstallation[]>([]);
  const [preview, setPreview] = useState<CustomerPackPreview | null>(null);
  const [change,setChange] = useState<CustomerPackChangePreview|null>(null);
  const [skills, setSkills] = useState<PackSkillReviewState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), pending = useRef(false);
  const loadGeneration=useRef(0);
  const load = async () => { const generation=++loadGeneration.current; if(alive.current)setChange(null); const [result, review] = await Promise.all([api('/api/customer-packs'), api('/api/customer-packs/skill-proposals')]); if (alive.current&&generation===loadGeneration.current) { setInstalled(result.installations); setSkills(review); } };
  useEffect(() => { alive.current = true; void load().catch(() => { if (alive.current) setError('Pack setup could not be checked. Your saved work is unchanged.'); }); return () => { alive.current = false; }; }, []);
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed. Refresh setup before trying again.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const inspect = async (pack: CustomerPack) => {
    setPreview(null); setChange(null);
    const current=await api('/api/customer-packs'),result=await api('/api/customer-packs/preview',{method:'POST',body:JSON.stringify({pack})});
    if(!alive.current)return; setInstalled(current.installations);
    if(current.installations.some((entry:CustomerPackInstallation)=>entry.id===result.pack.id&&entry.digest!==result.digest)) {
      const upgraded=await api('/api/customer-packs/upgrade/preview',{method:'POST',body:JSON.stringify({pack})}); if(alive.current)setChange(upgraded);
    } else setPreview(result);
  };
  const download = async (packId: 'office-core' | 'austin-office') => {
    const pack = await api(`/api/customer-packs/${packId}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `realbud-${packId}-v${pack.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (alive.current) setNotice('Portable pack downloaded. It includes plans and instructions; no customer records, sign-ins or local approvals.');
  };
  return <section aria-label="Customer workflow pack setup" className="mt-5 border-t border-line pt-4 space-y-4" aria-busy={busy}>
    <div><h3 className="font-medium text-ink">Customer workflow packs</h3><p className="mt-1 text-sm text-ink-secondary">One portable file brings together the work plans, Bud’s instructions and setup checks. Review it before adding anything to this computer.</p></div>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => void run(async () => inspect(await api('/api/customer-packs/office-core/export')))}>Preview real estate office core pack</button>
      <button className={button} disabled={busy} onClick={() => void run(() => download('office-core'))}>Download office core pack</button>
      <button className={button} disabled={busy} onClick={() => void run(async () => inspect(await api('/api/customer-packs/austin-office/export')))}>Preview Austin office pack</button>
      <button className={button} disabled={busy} onClick={() => void run(() => download('austin-office'))}>Download Austin pack</button>
      <label className={`${button} inline-flex cursor-pointer items-center has-[:disabled]:opacity-50`}>Preview a pack file<input className="sr-only" type="file" accept="application/json,.json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        void run(async () => { setPreview(null); if (file.size > 500_000) throw new Error('Choose a pack smaller than 500 KB.'); await inspect(JSON.parse(await file.text())); });
      }} /></label>
      <button className={button} disabled={busy} onClick={() => void run(load)}>Refresh setup checks</button>
    </div>
    <p className="text-sm text-ink-secondary">Office core uses your agency’s own identity and reviewed sources. Austin remains a separate customer pack. After import, explicitly choose which pack this agency uses in Agency details above.</p>
    {change&&<CustomerPackChangeReview key={change.previewDigest} preview={change} busy={busy} cancel={()=>setChange(null)} apply={()=>void run(async()=>{
      const body={expectedInstalledDigest:change.installedDigest,expectedInstalledRevision:change.installedRevision,expectedDigest:change.digest,expectedPreviewDigest:change.previewDigest,
        ...(change.action==='upgrade'?{pack:change.pack}:{packId:change.pack.id,installationRevision:change.rollbackRevision})};
      try { await api(`/api/customer-packs/${change.action}`,{method:'POST',body:JSON.stringify(body)},{timeoutMs:35_000}); }
      finally { if(alive.current)setChange(null); await load(); }
      await onInstalled?.(); if(alive.current)setNotice('The saved receipt confirms the version change. Review affected plans before approving or scheduling them again.');
    })}/>}
    {preview && <div role="group" aria-label="Review customer pack import" className="rounded-lg border border-agency p-4 space-y-3">
      <h4 className="font-medium">{preview.pack.title} · version {preview.pack.revision}</h4>
      <ul className="list-disc pl-5 text-sm">{preview.pack.workflows.map(workflow => <li key={workflow.id}>{workflow.title}</li>)}</ul>
      <p className="text-sm">{preview.additions.length} new plans · {preview.kept.length} existing plans kept · {preview.skills.filter(skill => skill.state === 'missing').length} instruction skills to install.</p>
      <p className="text-sm text-ink-secondary">This version prepares work from supplied source files. Import does not fetch mail, download bank files, change REI, test a paid model, approve a plan or turn on a schedule.</p>
      <details><summary className="min-h-11 cursor-pointer text-sm">Review included plans and instructions</summary><div className="max-h-96 overflow-auto space-y-3 text-sm">
        {preview.pack.recipes.map(recipe => <details key={recipe.id}><summary className="min-h-11 cursor-pointer">{recipe.title}</summary><p className="whitespace-pre-wrap break-words">{recipe.description}</p><ol className="list-decimal pl-5">{recipe.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>)}
        {preview.pack.skills.map(skill => <details key={skill.id}><summary className="min-h-11 cursor-pointer">Instruction skill: {skill.name}</summary><pre className="whitespace-pre-wrap break-words font-sans">{skill.instructions}</pre></details>)}
      </div></details>
      {!preview.canInstall && <p role="alert" className="text-sm text-danger">{preview.conflicts.join(' ') || 'An instruction file has local changes.'} Existing plans and files will not be overwritten.</p>}
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !preview.canInstall} onClick={() => void run(async () => {
        await api('/api/customer-packs/install', { method: 'POST', body: JSON.stringify({ pack: preview.pack, expectedDigest: preview.digest }) }, { timeoutMs: 30_000 });
        await load(); await onInstalled?.(); if (alive.current) { setPreview(null); setNotice('Pack installed locally. Review the setup checks below; account access and real workflow results still need verification.'); }
      })}>Import reviewed pack</button><button className={button} disabled={busy} onClick={() => setPreview(null)}>Cancel preview</button></div>
    </div>}
    {installed.map(pack => <article key={pack.id} className="rounded-lg border border-line p-4 space-y-3">
      <div><h4 className="font-medium">{pack.title} · version {pack.revision}</h4><p className="mt-1 text-sm">{pack.localReady ? 'Plans and instructions installed' : 'Local installation needs attention'}</p></div>
      <p className="text-sm text-ink-secondary">Local file checks, selected-account checks and a verified business result are separate. A saved connection or installed worker alone does not prove that a workflow can run successfully.</p>
      <ul className="divide-y divide-line">{pack.checks.map(check => <li key={check.id} className="py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong className="font-medium">{check.label}</strong><span className={check.state === 'passed' ? 'text-agency' : 'text-hold'}>{labels[check.state]}</span></div><p className="mt-1 text-ink-secondary">{check.detail}</p><p className="mt-1">{check.nextAction}</p></li>)}</ul>
      {pack.pendingChange&&<div role="alert" className="rounded border border-hold p-3 space-y-2 text-sm"><p>A reviewed {pack.pendingChange.action} to version {pack.pendingChange.targetRevision} needs recovery. Affected plans remain held. Resume the saved decision; do not import another copy.</p><button className={button} disabled={busy} onClick={()=>void run(async()=>{
        try {await api(`/api/customer-packs/${pack.id}/resume-change`,{method:'POST',body:JSON.stringify({expectedInstalledDigest:pack.digest,expectedInstalledRevision:pack.installationRevision,expectedPreviewDigest:pack.pendingChange!.previewDigest})},{timeoutMs:35_000});}
        finally {await load();} await onInstalled?.(); if(alive.current)setNotice('The saved pack change was reconciled. Review the paused plans again.');
      })}>Resume reviewed pack change</button></div>}
      {!pack.localReady && !pack.pendingChange && !pack.pendingArchive && <div className="space-y-2"><p className="text-sm">Repair adds only missing plans or missing, previously reviewed instruction files. It never replaces local edits, changes permissions or reconnects an account.</p><button className={button} disabled={busy} onClick={() => void run(async () => {
        await api(`/api/customer-packs/${pack.id}/repair`, { method: 'POST', body: JSON.stringify({ expectedDigest: pack.digest }) }, { timeoutMs: 30_000 }); await load(); await onInstalled?.();
        if (alive.current) setNotice('Missing local artifacts were checked and repaired. Review remaining setup requirements.');
      })}>Repair missing local files</button></div>}
      {!!pack.retiredRecipes?.length&&<p className="text-sm">Retired plans remain saved and cannot run through this pack: {pack.retiredRecipes.join(', ')}.</p>}
      <CustomerPackHistory pack={pack} busy={busy} run={run} reload={load} notice={setNotice} showChange={result => { setPreview(null); setChange(result); }} />
      <details><summary className="min-h-11 cursor-pointer text-sm">Installation receipt and update policy</summary><p className="text-sm text-ink-secondary">{pack.receipt.note}</p><p className="mt-2 text-sm">Bud may suggest a reviewed instruction revision below. Published pack content is retained separately; worker safeguards and permissions are unchanged.</p></details>
    </article>)}
    {skills && <PackSkillReview state={skills} busy={busy} run={run} reload={async () => { await load(); await onInstalled?.(); }} notice={message => { if (alive.current) setNotice(message); }} mutate={(route, body, message) => void run(async () => { try { await api(route, { method: 'POST', body: JSON.stringify(body) }, { timeoutMs: 30_000 }); } finally { await load(); await onInstalled?.(); } if (alive.current) setNotice(message); })} />}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <p role="status" className="text-sm text-ink-secondary">{busy ? 'Checking local pack setup…' : notice}</p>
  </section>;
}
