import { useEffect, useRef, useState } from 'react';
import type { CompanyStatus, CompanyWorkflowTemplate, CompanyWorkflowTemplateState } from '@shared/company-api';
import { companyApi } from '@/lib/company-api';
import { api } from '@/state/store';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';

/** Shares reviewed plans only. Approval, accounts and active clocks stay local. */
export function CompanyWorkflowTemplates({ onInstalled }: { onInstalled?: () => void | Promise<void> }) {
  const [company, setCompany] = useState<CompanyStatus | null>(null);
  const [saved, setSaved] = useState<CompanyWorkflowTemplateState | null>(null);
  const [preview, setPreview] = useState<CompanyWorkflowTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const loadGeneration = useRef(0);
  const load = async () => {
    const generation = ++loadGeneration.current;
    const status = await companyApi.status();
    const template = status.member ? await companyApi.workflowTemplate() : null;
    if (mounted.current && generation === loadGeneration.current) { setCompany(status); setSaved(template); setPreview(null); }
  };
  useEffect(() => { mounted.current = true; void load().catch(() => { if (mounted.current) setError('Company templates could not be checked. Refresh to try again.'); }); return () => { mounted.current = false; loadGeneration.current++; }; }, []);
  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Company templates are unavailable.'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const importSaved = async () => {
    if (!saved?.template) return;
    const current = await companyApi.status();
    if (!current.member || current.company?.id !== company?.company?.id || current.member.id !== company?.member?.id) {
      await load();
      throw new Error('Company sign-in changed. Review the current company plans before importing.');
    }
    await api('/api/workflow-packs/import', { method: 'POST', body: JSON.stringify(saved.template) });
    await onInstalled?.();
    setMessage('Company plans imported for local review. No schedule or approval was enabled. Existing plans were preserved.');
  };
  return <section aria-label="Company workflow templates" className="mt-5 border-t border-line pt-4">
    <h3 className="text-[14px] font-medium text-ink">Company workflow templates</h3>
    <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">Share a reviewed set of plans between profiles. Each person reviews sources and permissions on their own computer.</p>
    {!company?.member ? <p className="mt-3 text-[13px] text-ink-secondary">Sign in to your company under You → This office, then refresh here.</p> : <>
      <p className="mt-3 text-[13px] text-ink-secondary">{company.company?.name} · {company.member.displayName}</p>
      {saved?.template ? <>
        <p className="mt-2 text-[13px] text-ink">Shared version {saved.revision} · {saved.template.recipes.length} plans</p>
        <ul className="my-2 list-disc pl-5 text-[13px] text-ink-secondary">{saved.template.recipes.map(recipe => <li key={recipe.id}>{recipe.title}</li>)}</ul>
        <button className={button} disabled={busy} onClick={() => void perform(importSaved)}>Import company plans for review</button>
      </> : <p className="mt-2 text-[13px] text-ink-secondary">The owner has not shared a template yet.</p>}
      {company.member.role === 'owner' && !preview && <button className={`${button} mt-3 block`} disabled={busy || !saved} onClick={() => void perform(async () => {
        const template = await api('/api/workflow-packs/company-template');
        setPreview(template as CompanyWorkflowTemplate);
      })}>Review my plans for sharing</button>}
      {preview && <div className="mt-3 rounded-lg border border-line bg-inset p-3">
        <p className="text-[13px] font-medium text-ink">Share these plans with {company.company?.name}</p>
        <ul className="my-2 space-y-3 text-[13px] text-ink-secondary">{preview.recipes.map(recipe => <li key={recipe.id} className="break-words">
          <p className="font-medium text-ink">{recipe.title}</p><p className="mt-1">{recipe.description}</p>
          <details className="mt-1"><summary className="cursor-pointer py-1 text-ink">Review all shared details for {recipe.title}</summary>
            <ol className="my-2 list-decimal pl-5">{recipe.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
            <p>Expected result: {recipe.evidence}</p>
            <p className="mt-1">Requested capabilities: {recipe.capabilities.join(', ') || 'None'}</p>
            <p className="mt-1">Website scope: {recipe.allowedOrigins.join(', ') || 'None'}</p>
            <p className="mt-1">Limits: {recipe.limits.maxRuntimeMinutes} minutes · {recipe.limits.maxTurns} turns. Schedule off.</p>
          </details>
        </li>)}</ul>
        <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">The plan text will be visible to company members. Check it contains no private information. Schedules, approvals, account credentials and computer attachments are excluded.</p>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void perform(async () => {
          await companyApi.publishWorkflowTemplate(saved!.revision, preview, { companyId: company!.company!.id, memberId: company!.member!.id }); await load(); setMessage('Company template saved. Members can import it for review.');
        })}>Share with company</button><button className={button} disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div>
      </div>}
    </>}
    <button className={`${button} mt-3 block`} disabled={busy} onClick={() => void perform(load)}>{busy ? 'Working…' : 'Refresh company templates'}</button>
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    <p role="status" className="mt-2 text-[13px] text-ink-secondary">{message}</p>
  </section>;
}
