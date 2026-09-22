import { useEffect, useId, useRef, useState } from 'react';
import type { AssignDepartmentCaseInput, CloseDepartmentCaseInput, CreateDepartmentCaseInput, DepartmentCase, DepartmentCasePage, DepartmentAssigneePage, RecoverDepartmentCaseInput } from '@shared/company-api';
import { companyApi, departmentMutationUncertain } from '@/lib/company-api';
import { CompanyDepartmentPreparation } from './CompanyDepartmentPreparation';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[14px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'min-h-11 w-full min-w-0 rounded-lg border border-line bg-sheet p-3 text-ink focus-visible:outline-2 focus-visible:outline-agency';
const statuses = { open: 'Open', claimed: 'In progress', recovery_required: 'Needs owner review', done: 'Completed', cancelled: 'Closed without completing' };
type Editor = { kind: 'create' } | { kind: 'assign' | 'close' | 'recover'; item: DepartmentCase };
type Request = { kind: 'create'; input: CreateDepartmentCaseInput } | { kind: 'assign'; input: AssignDepartmentCaseInput } | { kind: 'close'; input: CloseDepartmentCaseInput } | { kind: 'recover'; input: RecoverDepartmentCaseInput };

/** Human case records and reconciliation; never a remote execution control. */
export function CompanyDepartmentCases({ departmentId, onChanged, onOperationChange, operationBlocked = false }: { departmentId: string; onChanged?: () => void; onOperationChange?: () => void; operationBlocked?: boolean }) {
  const labelId = useId();
  const [data, setData] = useState<DepartmentCasePage | null>(null);
  const [filter, setFilter] = useState<'needs-review' | 'all'>('all'), [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null), [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [resolution, setResolution] = useState<'done' | 'released' | 'cancelled'>('done'), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [assignee, setAssignee] = useState(''), [members, setMembers] = useState<DepartmentAssigneePage['members']>([]), [memberOffset, setMemberOffset] = useState(0), [moreMembers, setMoreMembers] = useState(false), [membersLoading, setMembersLoading] = useState(false);
  const [uncertain, setUncertain] = useState<Request | null>(null);
  const alive = useRef(true), pending = useRef(false), generation = useRef(0), editorGeneration = useRef(0), editing = useRef(false);
  const lastRequest = useRef<Request | null>(null);
  const clearEditor = () => { editing.current = false; editorGeneration.current++; setEditor(null); setNote(''); setConfirmed(false); setMembers([]); setMembersLoading(false); setMoreMembers(false); setMemberOffset(0); setAssignee(''); setTitle(''); setDescription(''); };
  const load = async () => {
    const current = ++generation.current, epoch = companyApi.sessionVersion();
    setLoading(true); setData(null); setError('');
    try {
      const result = await companyApi.departmentCases(departmentId, offset, filter);
      if (alive.current && current === generation.current && epoch === companyApi.sessionVersion()) setData(result);
    } catch (cause) {
      if (alive.current && current === generation.current && epoch === companyApi.sessionVersion()) {
        clearEditor();
        if (!departmentMutationUncertain(cause)) { lastRequest.current = null; setUncertain(null); }
        setError(cause instanceof Error ? cause.message : 'Department work could not be checked. Refresh when the host is available.');
      }
    } finally { if (alive.current && current === generation.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    const stop = companyApi.subscribeSession(() => { generation.current++; clearEditor(); lastRequest.current = null; setUncertain(null); setData(null); setNotice(''); setLoading(false); });
    const refresh = () => { if (!pending.current && !editing.current && !lastRequest.current) void load(); };
    window.addEventListener('focus', refresh); void load();
    return () => { alive.current = false; generation.current++; editorGeneration.current++; stop(); window.removeEventListener('focus', refresh); };
  }, [departmentId, offset, filter]);
  const loadMembers = async (nextOffset: number) => {
    const epoch = companyApi.sessionVersion(), version = editorGeneration.current;
    setMembersLoading(true); setError('');
    try {
      const page = await companyApi.departmentAssignees(departmentId, nextOffset);
      if (!alive.current || epoch !== companyApi.sessionVersion() || version !== editorGeneration.current) return;
      if (page.department.retiredAt) throw new Error('This department was retired. Refresh to view its records.');
      setMembers(old => nextOffset ? [...old, ...page.members.filter(item => !old.some(previous => previous.id === item.id))] : page.members);
      setMemberOffset(nextOffset); setMoreMembers(page.hasMore);
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion() && version === editorGeneration.current) {
        clearEditor(); setData(null); setError(cause instanceof Error ? cause.message : 'Assignable members could not be checked. Refresh before changing a case.');
      }
    } finally { if (alive.current && version === editorGeneration.current) setMembersLoading(false); }
  };
  const open = (next: Editor) => {
    clearEditor(); editing.current = true; setEditor(next); setResolution('done'); setNotice(''); setError('');
    if (next.kind === 'create' || next.kind === 'assign') {
      setAssignee(next.kind === 'assign' ? next.item.assignee?.id ?? '' : ''); void loadMembers(0);
    }
  };
  const submit = async (saved?: Request) => {
    if (pending.current) return;
    let request = saved;
    if (!request) {
      if (!editor || !data || data.department.retiredAt || operationBlocked) return;
      const base = { departmentId, requestId: crypto.randomUUID() };
      if (editor.kind === 'create') { if (!data.canCreate || !title.trim()) return; request = { kind: 'create', input: { ...base, title: title.trim(), description: description.trim(), assigneeMemberId: assignee || null } }; }
      else {
        const scoped = { ...base, caseId: editor.item.id, expectedFence: editor.item.fence };
        if (editor.kind === 'assign') { if (!editor.item.canAssign) return; request = { kind: 'assign', input: { ...scoped, assigneeMemberId: assignee || null } }; }
        else if (editor.kind === 'close') { if (!editor.item.canClose || !confirmed || !note.trim() || resolution === 'released') return; request = { kind: 'close', input: { ...scoped, resolution, note: note.trim() } }; }
        else { if (!data.canRecover || !confirmed || !note.trim() || resolution === 'cancelled') return; request = { kind: 'recover', input: { ...scoped, resolution, note: note.trim() } }; }
      }
    }
    lastRequest.current = request;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      if (request.kind === 'create') await companyApi.createDepartmentCase(request.input);
      else if (request.kind === 'assign') await companyApi.assignDepartmentCase(request.input);
      else if (request.kind === 'close') await companyApi.closeDepartmentCase(request.input);
      else await companyApi.recoverDepartmentCase(request.input);
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      lastRequest.current = null; setUncertain(null); clearEditor();
      setNotice(request.kind === 'recover' ? 'Recovery decision recorded. Open All work to see the review note. Anyone waiting to leave can refresh their membership settings.' : request.kind === 'create' ? 'Case saved. Open All work to view it. No work was started on another computer.' : request.kind === 'assign' ? 'Case assignment saved. No work was started on another computer.' : 'Case closure recorded with your note. No external action was performed.');
      await load(); onChanged?.();
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion()) {
        setData(null);
        if (departmentMutationUncertain(cause)) setUncertain(request);
        else { lastRequest.current = null; setUncertain(null); clearEditor(); }
        setError(cause instanceof Error ? cause.message : 'The result could not be confirmed. Retry the saved request to check its outcome.');
        onOperationChange?.();
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const retired = Boolean(data?.department.retiredAt), locked = busy || Boolean(uncertain) || operationBlocked;
  return <section aria-label="Department work review" className="border-t border-line pt-3 space-y-3 sm:rounded-lg sm:border sm:p-3" aria-busy={loading || busy}>
    <h4 className="font-medium">Department work{data ? ` · ${data.department.name}` : ''}</h4>
    <p className="text-ink-secondary">Keep shared case records, name the person responsible and record human decisions. Private Desk work and reviewed handoffs stay in their existing views. Case controls record human decisions. The separate preparation section requires member consent and owner approval before an assigned instance can work.</p>
    {retired && <p role="status" className="rounded-lg border border-line p-3">Retired department · records are read only. Case history and review notes are retained.</p>}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Department work filter">
      <button className={button} disabled={locked || loading || Boolean(editor)} aria-pressed={filter === 'needs-review'} onClick={() => { setOffset(0); setFilter('needs-review'); }}>Needs review</button>
      <button className={button} disabled={locked || loading || Boolean(editor)} aria-pressed={filter === 'all'} onClick={() => { setOffset(0); setFilter('all'); }}>All work</button>
      {data?.canCreate && !retired && <button className={button} disabled={locked || loading || Boolean(editor)} onClick={() => open({ kind: 'create' })}>Add a case</button>}
    </div>
    {loading && <p role="status">Checking department work…</p>}
    {data && <>
      {!data.canRecover && !retired && <p className="text-ink-secondary">Only the current office owner can resolve held work.</p>}
      {data.cases.length === 0 && <p>{filter === 'needs-review' ? 'No work needs owner review on this page.' : 'No department case records on this page.'}</p>}
      <ul className="space-y-3">{data.cases.map(item => <li key={item.id} className="rounded-lg border border-line p-3 space-y-2">
        <p className="break-words font-medium">{item.title}</p>
        <p>{item.needsReview ? 'Needs owner review' : statuses[item.status]}{item.holder ? ` · Claimed by ${item.holder.displayName}${item.holder.active ? '' : ' (access removed)'}` : ''}</p>
        <p className="text-ink-secondary">Assigned to: {item.assignee?.displayName ?? 'Unassigned'}{item.assignee && (!item.assignee.active || !item.assignee.canWrite) ? ' · no longer has editing access' : ''}{item.needsAssignment ? ' · assignment needed' : ''}</p>
        {item.description && <details><summary className="min-h-11 cursor-pointer content-center">Case details</summary><p className="whitespace-pre-wrap break-words">{item.description}</p></details>}
        {item.leaseExpiresAt && <p className="text-ink-secondary">Claim expiry: {new Date(item.leaseExpiresAt).toLocaleString()}. Refresh to check its current state.</p>}
        {item.lastRecovery && <div className="border-l-2 border-line pl-3 text-ink-secondary"><p>{item.lastRecovery.resolution === 'done' ? 'Marked completed' : 'Released for fresh work'} by {item.lastRecovery.reviewedBy} · {new Date(item.lastRecovery.reviewedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{item.lastRecovery.note}</p></div>}
        {item.lastClosure && <div className="border-l-2 border-line pl-3 text-ink-secondary"><p>{item.lastClosure.resolution === 'done' ? 'Completed' : 'Closed without completing'} by {item.lastClosure.recordedBy} · {new Date(item.lastClosure.recordedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{item.lastClosure.note}</p></div>}
        {!retired && <div className="flex flex-wrap gap-2">
          {item.canAssign && <button className={button} disabled={locked || loading || Boolean(editor)} onClick={() => open({ kind: 'assign', item })}>Change assignment<span className="sr-only">: {item.title}</span></button>}
          {item.canClose && <button className={button} disabled={locked || loading || Boolean(editor)} onClick={() => open({ kind: 'close', item })}>Close case<span className="sr-only">: {item.title}</span></button>}
          {data.canRecover && item.needsReview && <button className={button} disabled={locked || loading || Boolean(editor)} onClick={() => open({ kind: 'recover', item })}>Review held work<span className="sr-only">: {item.title}</span></button>}
        </div>}
      </li>)}</ul>
      {(offset > 0 || data.hasMore) && <div className="flex flex-wrap gap-2"><button className={button} disabled={locked || loading || Boolean(editor) || offset === 0} onClick={() => setOffset(value => value - 20)}>Previous work</button><button className={button} disabled={locked || loading || Boolean(editor) || !data.hasMore} onClick={() => setOffset(value => value + 20)}>Next work</button></div>}
    </>}
    <CompanyDepartmentPreparation key={departmentId} departmentId={departmentId} cases={data} operationBlocked={locked || loading || Boolean(editor)} onChanged={() => { void load(); onChanged?.(); }} />
    {editor && <form className="rounded-lg border border-agency p-3 space-y-3" aria-label={editor.kind === 'recover' ? 'Review interrupted department work' : editor.kind === 'create' ? 'Add department case' : editor.kind === 'assign' ? 'Change case assignment' : 'Close department case'} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h5 className="font-medium break-words">{editor.kind === 'create' ? 'Add a shared case' : `${editor.kind === 'recover' ? 'Review' : editor.kind === 'assign' ? 'Assign' : 'Close'}: ${editor.item.title}`}</h5>
      {editor.kind === 'create' && <><label className="block space-y-1">Case title<input className={field} value={title} maxLength={240} required disabled={locked} onChange={event => setTitle(event.target.value)} /></label><label className="block space-y-1">Case details (optional)<textarea className={`${field} min-h-24`} value={description} maxLength={4000} disabled={locked} onChange={event => setDescription(event.target.value)} /></label></>}
      {(editor.kind === 'create' || editor.kind === 'assign') && <><label className="block space-y-1"><span id={`${labelId}-assignee`}>Person responsible</span><select aria-labelledby={`${labelId}-assignee`} className={field} value={assignee} disabled={locked || membersLoading} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{assignee && !members.some(item => item.id === assignee) && <option value={assignee} disabled>Current person · check current access</option>}{members.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><p className="text-ink-secondary">Only people with current editing access appear. Assigning a case does not send a message or start a worker.</p>{moreMembers && <button type="button" className={button} disabled={locked || membersLoading} onClick={() => void loadMembers(memberOffset + 100)}>Load more people</button>}</>}
      {(editor.kind === 'close' || editor.kind === 'recover') && <>
        <p>{editor.kind === 'recover' ? 'Check the original result with the person or system involved before deciding. An expired or revoked claim does not prove that an external action stopped or failed.' : 'Record what happened before closing this case. This changes the shared case record only.'}</p>
        <label className="block space-y-1"><span id={`${labelId}-decision`}>What did you confirm?</span><select aria-labelledby={`${labelId}-decision`} className={field} value={resolution} disabled={locked} onChange={event => { setResolution(event.target.value as typeof resolution); setConfirmed(false); }}><option value="done">Confirmed complete</option>{editor.kind === 'recover' ? <option value="released">Safe to try again</option> : <option value="cancelled">Close without completing</option>}</select></label>
        <label className="block space-y-1"><span id={`${labelId}-note`}>Review note</span><textarea aria-labelledby={`${labelId}-note`} className={`${field} min-h-24`} value={note} maxLength={2048} required disabled={locked} onChange={event => setNote(event.target.value)} placeholder="Describe the result you checked and why this decision is safe." /></label>
        <label className="flex min-h-11 items-start gap-2 py-2"><input type="checkbox" className="mt-1" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /><span>I checked the result. {resolution === 'released' ? 'Repeating this work will not duplicate a completed action.' : resolution === 'cancelled' ? 'This case should close without being marked completed.' : 'This case can be marked completed.'}</span></label>
      </>}
      <p className="text-ink-secondary">This records your decision. It does not send a message, approve a payment, start a worker or reverse an external action.</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={locked || loading || !data || membersLoading || (editor.kind === 'create' ? !title.trim() : editor.kind === 'assign' ? false : !confirmed || !note.trim())}>{editor.kind === 'recover' ? 'Record recovery decision' : editor.kind === 'create' ? 'Save case' : editor.kind === 'assign' ? 'Save assignment' : 'Record case closure'}</button><button type="button" className={button} disabled={locked} onClick={clearEditor}>{editor.kind === 'recover' ? 'Keep on hold' : 'Cancel'}</button></div>
    </form>}
    {uncertain && !operationBlocked && <div role="status" className="rounded-lg border border-hold p-3 space-y-2"><p>The last change may already be saved. Keep the same request to check its result; no new case or decision will be created by this retry.</p><button className={button} disabled={busy} onClick={() => void submit(uncertain)}>Check and retry saved request</button></div>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <p role="status" className="text-ink-secondary">{busy ? 'Saving and checking department work…' : notice}</p>
    <button className={button} disabled={busy || loading || Boolean(editor && !uncertain)} onClick={() => void load()}>Refresh department work</button>
  </section>;
}
