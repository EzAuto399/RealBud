import { useCallback, useEffect, useRef, useState } from 'react';
import { companyApi, departmentMutationUncertain } from '@/lib/company-api';
import { DEPARTMENT_CONFIGURATION_MAX_BYTES, departmentConfigurationReviewMaterial, normalizeDepartmentConfiguration, type DepartmentConfiguration, type DepartmentConfigurationCandidates, type DepartmentConfigurationHistory, type DepartmentConfigurationHistoryItem } from '@shared/department-configuration';
import { canonicalWebsiteCommand } from '@shared/website-commands';
import { Card } from './SettingsPrimitives';
import { DepartmentPreparationReview } from './CompanyDepartmentPreparation';
import type { DepartmentCasePage } from '@shared/company-api';
import type { DepartmentWorkPage } from '@shared/department-work';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[14px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'min-h-11 w-full min-w-0 rounded-lg border border-line bg-sheet p-3 text-ink focus-visible:outline-2 focus-visible:outline-agency';
const empty: DepartmentConfiguration = { version: 1, template: 'custom', plans: [], workflowDefaults: [] };
const templates = { 'accounts-admin': 'Accounts and general admin', 'property-management': 'Property Management', custom: 'Custom department' };
const starterWorkflows = {
  'accounts-admin': [ ['invoice', 'Invoice issues', 'accounts-invoice'], ['admin', 'General admin and mail cases', 'accounts-admin'], ['bank', 'Bank exceptions', 'accounts-bank'] ],
  'property-management': [ ['property', 'Owner and property cases', 'pm-property'], ['maintenance', 'Maintenance and inspections', 'pm-maintenance'] ],
  custom: [],
} satisfies Record<DepartmentConfiguration['template'], string[][]>;

/** Selection is convenience only; exact reviewed plan bytes remain the authority. */
export function departmentStarterSelection(data: DepartmentConfigurationCandidates, template: DepartmentConfiguration['template']): DepartmentConfiguration {
  const workflows = starterWorkflows[template];
  const plans = workflows.flatMap(([, , suffix]) => data.candidates.filter(plan => plan.recipe.id === `wf-department-starters-${suffix}`));
  return { version: 1, template, plans, workflowDefaults: workflows.map(([id, label, suffix]) => ({ id, label, defaultRecipeId: plans.find(plan => plan.recipe.id === `wf-department-starters-${suffix}`)?.recipe.id ?? null })) };
}

export function departmentConfigurationUnchanged(current: DepartmentConfiguration | null, draft: DepartmentConfiguration): boolean {
  try { return current !== null && canonicalWebsiteCommand(normalizeDepartmentConfiguration(current)) === canonicalWebsiteCommand(normalizeDepartmentConfiguration(draft)); }
  catch { return false; }
}

/** These bounded pages are a preview, never an execution or permission decision. */
export function departmentConfigurationImpact(preparations: Pick<DepartmentWorkPage, 'hasMore'> & { grants: Pick<DepartmentWorkPage['grants'][number], 'current' | 'phase'>[] }, cases: Pick<DepartmentCasePage, 'hasMore'> & { cases: Pick<DepartmentCasePage['cases'][number], 'status'>[] }) {
  // The grant list is oldest first. Never present its first page as a useful
  // count when later pages may contain the live permissions being withdrawn.
  if (preparations.hasMore || cases.hasMore) return { permissions: null, claimed: null, complete: false } as const;
  return { permissions: preparations.grants.filter(grant => grant.current && grant.phase !== 'revoked').length,
    claimed: cases.cases.filter(item => item.status === 'claimed').length, complete: true } as const;
}

export function departmentConfigurationImpactSummary(impact: ReturnType<typeof departmentConfigurationImpact>): string {
  return impact.complete ? `Current preview: ${impact.permissions} valid preparation permissions and ${impact.claimed} claimed cases. Work can change after this check.`
    : 'This preview cannot count all affected work because this department has more records than one page. Review department work before changing settings.';
}

function ConfigurationImpact({ departmentId, revision }: { departmentId: string; revision: string }) {
  const [impact, setImpact] = useState<ReturnType<typeof departmentConfigurationImpact> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const epoch = companyApi.sessionVersion();
    setImpact(null); setFailed(false);
    void Promise.all([companyApi.departmentPreparations(departmentId), companyApi.departmentCases(departmentId, 0, 'all')]).then(([preparations, cases]) => {
      if (!active || epoch !== companyApi.sessionVersion()) return;
      if (cases.department.revision !== revision) { setFailed(true); return; }
      setImpact(departmentConfigurationImpact(preparations, cases));
    }).catch(() => { if (active && epoch === companyApi.sessionVersion()) setFailed(true); });
    return () => { active = false; };
  }, [departmentId, revision]);
  return <p className="text-ink-secondary" role="status">{impact
    ? `${departmentConfigurationImpactSummary(impact)} Saving changed settings withdraws all preparation permissions in this department and holds claimed cases for owner recovery.`
    : failed ? 'Affected work could not be counted. Saving changed settings still withdraws all preparation permissions in this department and holds claimed cases for owner recovery.'
    : 'Checking affected preparation permissions and claimed cases…'}</p>;
}

export function CompanyDepartmentConfiguration({ departmentId, operationBlocked, onDirtyChange }: { departmentId: string; operationBlocked: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [data, setData] = useState<DepartmentConfigurationCandidates | null>(null);
  const [draft, setDraft] = useState<DepartmentConfiguration>(empty);
  const [history, setHistory] = useState<DepartmentConfigurationHistory | null>(null);
  const [sourceReceiptId, setSourceReceiptId] = useState<string | null>(null);
  const [note, setNote] = useState(''), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), pending = useRef(false), generation = useRef(0), dirty = useRef(false);
  const load = useCallback(async (keepDraft: boolean) => {
    const version = ++generation.current, epoch = companyApi.sessionVersion();
    setLoading(true);
    try {
      const next = await companyApi.departmentConfigurationCandidates(departmentId);
      if (!alive.current || version !== generation.current || epoch !== companyApi.sessionVersion()) return;
      setData(next); setReviewed(false); setNeedsRefresh(false);
      if (!keepDraft) { setDraft(next.configuration ?? empty); setSourceReceiptId(null); setNote(''); dirty.current = false; onDirtyChange?.(false); }
      else setNotice('Current settings refreshed. Your draft is kept below. Compare the saved plans and review your draft again before saving.');
    } catch (cause) {
      if (alive.current && version === generation.current && epoch === companyApi.sessionVersion()) { setData(null); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : 'Department setup could not be checked.'); }
    } finally { if (alive.current && version === generation.current) setLoading(false); }
  }, [departmentId]);
  useEffect(() => {
    alive.current = true; dirty.current = false; onDirtyChange?.(false); setData(null); setDraft(empty); setHistory(null); setSourceReceiptId(null); setNote(''); setNotice(''); setError(''); setReviewed(false);
    void load(false);
    const stopSession = companyApi.subscribeSession(() => { generation.current++; setData(null); setDraft(empty); setHistory(null); setNote(''); setSourceReceiptId(null); setReviewed(false); setLoading(false); setNotice(''); dirty.current = false; onDirtyChange?.(false); });
    const stopChanges = companyApi.subscribeDepartmentChanges(() => {
      if (pending.current) return;
      if (dirty.current) { setNeedsRefresh(true); setReviewed(false); setNotice('Office settings changed while you were editing. Refresh current settings; your draft will be kept.'); }
      else void load(false);
    });
    return () => { alive.current = false; generation.current++; stopSession(); stopChanges(); onDirtyChange?.(false); };
  }, [load]);
  const change = (next: DepartmentConfiguration) => { dirty.current = true; onDirtyChange?.(true); setDraft(next); setReviewed(false); setSourceReceiptId(null); setNotice(''); };
  const blocked = busy || loading || operationBlocked || needsRefresh || !data?.canManage || !!data.department.retiredAt;
  const available = (plan: DepartmentConfiguration['plans'][number]) => data?.candidates.some(candidate => canonicalWebsiteCommand(candidate) === canonicalWebsiteCommand(plan));
  // Local counters can differ after importing the same pack on another installation.
  const compatible = (plan: DepartmentConfiguration['plans'][number]) => data?.candidates.find(candidate => candidate.recipe.id === plan.recipe.id && candidate.recipe.digest === plan.recipe.digest && candidate.recipe.instructionDigest === plan.recipe.instructionDigest && canonicalWebsiteCommand(candidate.recipe.review) === canonicalWebsiteCommand(plan.recipe.review) && canonicalWebsiteCommand(candidate.pack) === canonicalWebsiteCommand(plan.pack));
  const starterMissing = starterWorkflows[draft.template].filter(([, , suffix]) => !data?.candidates.some(plan => plan.recipe.id === `wf-department-starters-${suffix}`)).length;
  const unavailable = draft.plans.filter(plan => !available(plan) && !compatible(plan));
  const unchanged = !!data && departmentConfigurationUnchanged(data.configuration, draft);
  const save = async () => {
    if (pending.current || blocked || unchanged || !reviewed || !note.trim() || unavailable.length) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    let dispatched = false;
    try {
      const status = await companyApi.status();
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      if (!status.company || status.member?.role !== 'owner') throw new Error('Sign in as this company’s owner before configuring workflows.');
      if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > DEPARTMENT_CONFIGURATION_MAX_BYTES) throw new Error('These plans exceed the department settings size limit. Select fewer plans or shorten their reviewed instructions before saving.');
      const configuration = normalizeDepartmentConfiguration(draft);
      const input = { departmentId, expectedRevision: data!.department.revision, configuration, note: note.trim(), sourceReceiptId };
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(departmentConfigurationReviewMaterial(status.company.id, input)));
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      const reviewDigest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
      dispatched = true;
      const result = await companyApi.saveDepartmentConfiguration({ ...input, requestId: crypto.randomUUID(), reviewDigest });
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      dirty.current = false; onDirtyChange?.(false); setHistory(null); await load(false);
      if (alive.current && epoch === companyApi.sessionVersion()) setNotice(`Workflow settings saved as department revision ${result.department.revision}. No preparation was started. Earlier preparation permissions need fresh review.`);
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion()) {
        setReviewed(false); setNeedsRefresh(dispatched);
        setError(!dispatched ? `${cause instanceof Error ? cause.message : 'Check the workflow settings.'} No save was sent. Your draft is kept.` : departmentMutationUncertain(cause) ? 'The save may already be recorded. Your draft is kept. Use Saved department change above to retry the original request before making another change.' : `${cause instanceof Error ? cause.message : 'Settings could not be saved.'} Your draft is kept; refresh current settings and review again.`);
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const showHistory = async (before: string | null = null) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); const epoch = companyApi.sessionVersion();
    try { const result = await companyApi.departmentConfigurationHistory(departmentId, before); if (alive.current && epoch === companyApi.sessionVersion()) setHistory(result); }
    catch (cause) { if (alive.current && epoch === companyApi.sessionVersion()) setError(cause instanceof Error ? cause.message : 'History could not be checked.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const restoreDraft = (entry: DepartmentConfigurationHistoryItem) => { if (blocked || dirty.current) return; dirty.current = true; onDirtyChange?.(true); setDraft(entry.configuration); setSourceReceiptId(entry.receiptId); setReviewed(false); setNote(`Restore reviewed settings from revision ${entry.revision}.`); setNotice('Earlier settings loaded as a draft. Review every plan and save to create a new revision. Earlier approvals are not restored.'); };
  return <section aria-label="Department workflow configuration" className="min-w-0 space-y-4" aria-busy={busy || loading}>
    <Card className="max-[719px]:border-0 max-[719px]:p-0" title={data ? `Workflows for ${data.department.name}` : 'Department workflows'} subtitle="Choose the reviewed plans this department can use. Each assigned case still needs its own owner approval.">
      <div className="space-y-4 text-[14px] leading-relaxed">
        {loading && <p role="status">Checking current workflow settings…</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {data && <>
          <p className="text-ink-secondary">{data.configuration ? `Saved: ${templates[data.configuration.template]} · ${data.configuration.plans.length} plans · revision ${data.department.revision}` : 'No workflows configured yet. Choose a department type, select reviewed plans and save.'}</p>
          {data.configuration && <details><summary className="min-h-11 cursor-pointer content-center">View current saved plans and defaults</summary><div className="space-y-3">
            {data.configuration.plans.map(plan => <details key={plan.recipe.id}><summary className="min-h-11 cursor-pointer content-center">Saved plan: {plan.recipe.review.plan.title}</summary><DepartmentPreparationReview review={plan.recipe.review}/></details>)}
            <h4 className="font-medium">Saved work type defaults</h4>
            {data.configuration.workflowDefaults.length === 0 && <p>No default work types.</p>}
            {data.configuration.workflowDefaults.map(item => <p key={item.id} className="break-words">{item.label}: {data.configuration!.plans.find(plan => plan.recipe.id === item.defaultRecipeId)?.recipe.review.plan.title ?? 'Choose each time'}</p>)}
          </div></details>}
          {data.department.retiredAt && <p>This department is retired. Reopen it before changing workflow settings.</p>}
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
            <fieldset disabled={blocked} className="min-w-0 space-y-4">
              <label className="block space-y-1">Department type<select className={field} value={draft.template} onChange={event => change({ ...draft, template: event.target.value as DepartmentConfiguration['template'] })}>{Object.entries(templates).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              {draft.template !== 'custom' && <button type="button" className={button} onClick={() => change(departmentStarterSelection(data, draft.template))}>Use available {draft.template === 'accounts-admin' ? 'Accounts' : 'Property Management'} starter plans</button>}
              {draft.template !== 'custom' && starterMissing > 0 && <p role="status">{starterMissing} of {starterWorkflows[draft.template].length} starter plans are not ready on this computer. Using available starters selects only the ready plans; missing work types stay without a default.</p>}
              <p className="text-ink-secondary">Selecting starter plans replaces this draft’s selection and defaults. Only locally approved, ready plans can be selected. Import the department starter pack in Schedule if these plans are missing.</p>
              <div className="space-y-2"><h4 className="font-medium">Reviewed plans · {draft.plans.length} of 8 selected</h4>
                {data.candidates.length === 0 && <p>No eligible plans on this computer. Import a starter pack and review its plans before returning here.</p>}
                {data.candidates.map(plan => { const selected = draft.plans.some(item => item.recipe.id === plan.recipe.id); return <div key={plan.recipe.id} className="border-b border-line pb-3">
                  <label className="flex min-h-11 items-start gap-3 py-2"><input type="checkbox" className="mt-1" checked={selected} disabled={blocked || !selected && draft.plans.length >= 8} onChange={event => change({ ...draft, plans: event.target.checked ? [...draft.plans,plan] : draft.plans.filter(item => item.recipe.id !== plan.recipe.id), workflowDefaults: draft.workflowDefaults.map(item => item.defaultRecipeId === plan.recipe.id && !event.target.checked ? { ...item, defaultRecipeId:null } : item) })}/><span className="min-w-0 break-words">{plan.recipe.review.plan.title}<span className="block text-[13px] text-ink-secondary">{plan.pack ? `Pack ${plan.pack.id} · version ${plan.pack.revision}` : 'Local reviewed plan'}</span></span></label>
                  <details><summary className="min-h-11 cursor-pointer content-center text-ink-secondary">Read complete plan and instructions: {plan.recipe.review.plan.title}</summary><DepartmentPreparationReview review={plan.recipe.review}/></details>
                </div>; })}
              </div>
              {unavailable.length > 0 && <div role="status" className="space-y-2"><p>These selected plans are unavailable or changed. Remove them or restore their exact reviewed version before saving.</p>{unavailable.map(plan => <div key={plan.recipe.id}><p>{plan.recipe.review.plan.title}</p><button type="button" className={button} onClick={() => change({ ...draft, plans:draft.plans.filter(item => item.recipe.id !== plan.recipe.id), workflowDefaults:draft.workflowDefaults.map(item => item.defaultRecipeId === plan.recipe.id ? { ...item, defaultRecipeId:null } : item) })}>Remove unavailable plan: {plan.recipe.review.plan.title}</button></div>)}</div>}
              {draft.workflowDefaults.length > 0 && <div className="space-y-3"><h4 className="font-medium">Default plan by work type</h4><p className="text-ink-secondary">Defaults help members select a plan. They do not start work or change anyone’s permissions.</p>{draft.workflowDefaults.map((item,index) => <div key={item.id} className="space-y-2"><label className="block">Work type name<input className={field} value={item.label} maxLength={120} required onChange={event => change({ ...draft, workflowDefaults:draft.workflowDefaults.map((row,i) => i === index ? { ...row,label:event.target.value } : row) })}/></label><label className="block">Default plan for {item.label}<select className={field} value={item.defaultRecipeId ?? ''} onChange={event => change({ ...draft, workflowDefaults:draft.workflowDefaults.map((row,i) => i === index ? { ...row,defaultRecipeId:event.target.value || null } : row) })}><option value="">Choose each time</option>{draft.plans.map(plan => <option key={plan.recipe.id} value={plan.recipe.id}>{plan.recipe.review.plan.title}</option>)}</select></label><button type="button" className={button} onClick={() => change({ ...draft, workflowDefaults: draft.workflowDefaults.filter(row => row.id !== item.id) })}>Remove work type: {item.label}</button></div>)}</div>}
              <button type="button" className={button} disabled={draft.workflowDefaults.length >= 8} onClick={() => change({ ...draft, workflowDefaults: [...draft.workflowDefaults, { id: `work-${crypto.randomUUID()}`, label: 'New work type', defaultRecipeId: null }] })}>Add work type default</button>
              <label className="block space-y-1">Reason for these settings<textarea className={`${field} min-h-24`} required maxLength={2048} value={note} onChange={event => { dirty.current = true; onDirtyChange?.(true); setNote(event.target.value); setReviewed(false); }}/></label>
              <p className="text-ink-secondary">Saving shares the selected plan text, instructions, reason and full settings history with this department’s members. Include no secrets or private customer records.</p>
              <ConfigurationImpact departmentId={departmentId} revision={data.department.revision}/>
              {unchanged && <p role="status">These settings match the saved configuration. Change the settings before saving; adding a reason alone does not create a revision.</p>}
              {sourceReceiptId && <p>Restoring earlier settings creates a new revision and keeps the full history.</p>}
              <label className="flex min-h-11 items-start gap-3 py-2"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/><span>I reviewed the selected plans, instructions and defaults, and their effect on existing preparation permissions.</span></label>
              <button className={`${button} bg-agency text-sheet`} disabled={blocked || unchanged || !reviewed || !note.trim() || unavailable.length > 0}>Save reviewed department workflows</button>
            </fieldset>
          </form>
          {data.unavailable.length > 0 && <details><summary className="min-h-11 cursor-pointer content-center">Why some plans are unavailable</summary>{data.unavailable.map((item,index) => <p key={`${item.id}:${index}`} className="break-words">{item.reason}</p>)}</details>}
          {data.omitted > 0 && <p>{data.omitted} more plans were omitted. Narrow your local plan library before configuring them.</p>}
        </>}
        <div className="flex flex-wrap gap-2">{dirty.current && <button type="button" className={button} disabled={busy || loading || operationBlocked} onClick={() => { setError(''); setNotice(''); void load(false); }}>Discard unsaved workflow draft</button>}<button type="button" className={button} disabled={busy || loading} onClick={() => { setError(''); void load(dirty.current); }}>Refresh current workflow settings</button><button type="button" className={button} disabled={busy || loading || !data?.canManage} onClick={() => void showHistory()}>View workflow settings history</button></div>
      </div>
    </Card>
    {history && <Card title="Workflow settings history"><div className="space-y-4">
      {history.entries.length === 0 && <p>No saved workflow settings on this page.</p>}
      {dirty.current && <p role="status">Discard your unsaved workflow draft before loading an earlier revision.</p>}
      {history.entries.map(entry => <article key={entry.receiptId} className="space-y-2 border-b border-line pb-3"><h4 className="font-medium">Revision {entry.revision} · {templates[entry.configuration.template]}</h4><p className="text-ink-secondary">{new Date(entry.savedAt).toLocaleString()} · {entry.savedBy.displayName}</p><p className="whitespace-pre-wrap break-words">{entry.note}</p><p>{entry.configuration.plans.length ? entry.configuration.plans.map(plan => plan.recipe.review.plan.title).join('; ') : 'No reviewed plans'}</p><button type="button" className={button} disabled={blocked || dirty.current} onClick={() => restoreDraft(entry)}>Review revision {entry.revision} as a new draft</button></article>)}
      {history.nextBeforeRevision && <button type="button" className={button} disabled={busy} onClick={() => void showHistory(history.nextBeforeRevision)}>Older workflow settings</button>}
    </div></Card>}
  </section>;
}
