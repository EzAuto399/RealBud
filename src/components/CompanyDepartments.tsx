import { useEffect, useRef, useState } from 'react';
import type { CompanyDepartment, DepartmentAccess, DepartmentAccessPage, DepartmentPage, DepartmentLifecycleInput } from '@shared/company-api';
import { companyApi, departmentMutationUncertain } from '@/lib/company-api';
import { departmentOperationTitle, type DepartmentOutboxState } from '@shared/company-department-outbox';
import { CompanyDepartmentCases } from './CompanyDepartmentCases';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[14px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-agency';
const accessLabels = { none: 'No access', read: 'Read only', write: 'Read and edit' };

export function CompanyDepartments() {
  const [outbox, setOutbox] = useState<DepartmentOutboxState | null>(null), [caseRefresh, setCaseRefresh] = useState(0);
  const [data, setData] = useState<DepartmentPage | null>(null);
  const [access, setAccess] = useState<DepartmentAccessPage | null>(null);
  const [selected, setSelected] = useState('');
  const [workDepartment, setWorkDepartment] = useState('');
  const [offset, setOffset] = useState(0);
  const [memberOffset, setMemberOffset] = useState(0);
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, DepartmentAccess>>({});
  const [confirm, setConfirm] = useState<{ id: string; name: string; access: DepartmentAccess } | null>(null);
  const [retirement, setRetirement] = useState<CompanyDepartment | null>(null), [retirementNote, setRetirementNote] = useState(''), [retirementConfirmed, setRetirementConfirmed] = useState(false);
  const [uncertainRetirement, setUncertainRetirement] = useState<DepartmentLifecycleInput | null>(null);
  const retirementRequest = useRef<DepartmentLifecycleInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true), pending = useRef(false), generation = useRef(0);
  const creation = useRef<{ id: string; name: string } | null>(null);
  const load = async () => {
    const version = ++generation.current, epoch = companyApi.sessionVersion();
    setLoading(true); setError('');
    try {
      const reads = await Promise.allSettled([companyApi.departments(offset), companyApi.pendingDepartmentOperation()]);
      if (!alive.current || generation.current !== version || companyApi.sessionVersion() !== epoch) return;
      if (reads[1].status === 'rejected') { setOutbox(null); throw reads[1].reason; }
      setOutbox(reads[1].value);
      if (reads[0].status === 'rejected') throw reads[0].reason;
      const next = reads[0].value;
      const members = selected && next.canManage && next.departments.some(item => item.id === selected) ? await companyApi.departmentAccess(selected, memberOffset) : null;
      if (!alive.current || generation.current !== version || companyApi.sessionVersion() !== epoch) return;
      setData(next); setAccess(members); setDrafts({}); setConfirm(null);
      setRetirement(current => current && next.canManage ? next.departments.find(item => item.id === current.id && Boolean(item.retiredAt) === Boolean(current.retiredAt)) ?? null : null); setRetirementConfirmed(false);
      if (!next.canManage) { setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false); setUncertainRetirement(null); retirementRequest.current = null; }
    } catch (cause) {
      if (alive.current && generation.current === version && companyApi.sessionVersion() === epoch) {
        setData(null); setAccess(null); setConfirm(null); setRetirement(null); setRetirementConfirmed(false);
        if (!departmentMutationUncertain(cause)) { setUncertainRetirement(null); retirementRequest.current = null; }
        setError(cause instanceof Error ? cause.message : 'Departments could not be checked. Refresh when the office host is available.');
      }
    } finally { if (alive.current && generation.current === version) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    const stop = companyApi.subscribeSession(() => { generation.current++; setOutbox(null); setData(null); setAccess(null); setConfirm(null); setDrafts({}); setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false); setUncertainRetirement(null); retirementRequest.current = null; setNotice(''); setLoading(false); });
    const stopDepartment = companyApi.subscribeDepartmentChanges(() => { if (!pending.current) void load(); });
    void load();
    return () => { alive.current = false; generation.current++; stop(); stopDepartment(); };
  }, [offset, selected, memberOffset]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      await action();
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      setNotice(success); setConfirm(null); await load();
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion()) {
        setData(null); setAccess(null); setConfirm(null);
        setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before trying again.');
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const resume = async () => {
    const saved = outbox?.pending; if (!saved || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      if (saved.phase === 'confirmed') await companyApi.acknowledgeDepartmentOperation(saved.input.requestId);
      else await companyApi.resumeDepartmentOperation(saved);
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      setUncertainRetirement(null); retirementRequest.current = null; setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false);
      setCaseRefresh(value => value + 1); setWorkDepartment(saved.input.departmentId);
      setNotice('Saved department change confirmed.'); await load();
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion()) {
        setData(null); setAccess(null); setConfirm(null); setRetirement(null); setRetirementConfirmed(false);
        setError(cause instanceof Error ? cause.message : 'Saved change could not be checked. Use Connection and work recovery if the original office is unavailable.');
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const retire = async (retry?: DepartmentLifecycleInput) => {
    if (pending.current) return;
    if (!retry && operationBlocked) return;
    if (!retry && (!retirement || !data?.canManage || !retirementConfirmed || !retirementNote.trim() || (!retirement.retiredAt && retirement.unresolvedCases))) return;
    const request = retry ?? { departmentId: retirement!.id, requestId: crypto.randomUUID(), expectedRevision: retirement!.revision, retired: !retirement!.retiredAt, note: retirementNote.trim() };
    retirementRequest.current = request;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      await companyApi.setDepartmentLifecycle(request);
      if (!alive.current || epoch !== companyApi.sessionVersion()) return;
      retirementRequest.current = null; setUncertainRetirement(null); setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false); setSelected(''); setAccess(null);
      setNotice(request.retired ? 'Department retired. Its case history is still available through View work.' : 'Department reopened. Existing access applies again. No work was started.'); await load();
    } catch (cause) {
      if (alive.current && epoch === companyApi.sessionVersion()) {
        setData(null); setAccess(null); setConfirm(null);
        if (departmentMutationUncertain(cause)) { setUncertainRetirement(request); }
        else { retirementRequest.current = null; setUncertainRetirement(null); setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false); }
        void load();
        setError(cause instanceof Error ? cause.message : 'The department change could not be confirmed. Retry the same saved request to check it.');
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const saveAccess = (memberId: string, next: DepartmentAccess) => {
    if (!access || operationBlocked || uncertainRetirement) return;
    const current = access.members.find(member => member.id === memberId)?.access;
    if (!current || (access.department.retiredAt && next !== 'none' && !(current === 'write' && next === 'read'))) return;
    const change = { departmentId: access.department.id, memberId, access: next, expectedRevision: access.department.revision };
    void run(() => companyApi.setDepartmentAccess(change), 'Department access saved and checked.');
  };
  const operationBlocked = !outbox || Boolean(outbox.pending) || outbox.otherOfficePending;
  return <details className="rounded-lg border border-line p-3">
    <summary className="min-h-11 cursor-pointer content-center text-[14px] font-medium text-ink">Departments and access</summary>
    <div className="mt-2 space-y-4 text-[14px]" aria-busy={busy || loading}>
      <p className="text-ink-secondary">Departments organise access to shared office records. Each person keeps their own Bud, browser sign-ins and private work on their computer.</p>
      <p className="text-ink-secondary">Joining a department does not move private Desk items or start work on another computer. Reviewed handoffs remain under Shared work on Desk.</p>
      {outbox?.pending && <section aria-label="Saved department change" className="rounded-lg border border-hold p-3 space-y-2">
        <h4 className="font-medium">A saved department change needs your attention</h4>
        <p className="break-words">{departmentOperationTitle(outbox.pending)}</p>
        <p>{outbox.pending.phase === 'confirmed' ? 'The office host confirmed this change. Acknowledge it before starting another change.' : 'The last result is uncertain. Resume the original request to check it without creating a duplicate.'}</p>
        <p className="text-ink-secondary">This request is stored privately on this installation. If the original office or membership is unavailable, use Connection and work recovery.</p>
        <button className={button} disabled={busy || loading} onClick={() => void resume()}>{outbox.pending.phase === 'confirmed' ? 'Acknowledge saved department change' : 'Retry saved department change'}</button>
      </section>}
      {outbox?.otherOfficePending && <p role="status">Another office has a saved department change on this installation. Use Connection and work recovery before starting new department work.</p>}
      {loading && <p role="status">Checking departments…</p>}
      {data && <>
        {!data.canManage && <p className="text-ink-secondary">Your office owner manages access. Only departments available to you appear here.</p>}
        {data.departments.length === 0 && <p>{data.canManage ? 'No departments on this page. Create one such as Accounts, Leasing or Maintenance, then choose who can use it.' : 'No departments are available to you on this page. Ask your office owner if you need access.'}</p>}
        <ul className="divide-y divide-line">{data.departments.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <span className="min-w-0 break-words"><strong className="font-medium">{item.name}</strong><span className="block text-ink-secondary">{item.retiredAt ? 'Retired · records are read only' : data.canManage ? 'You manage access as office owner' : accessLabels[item.access]}</span></span>
          <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || loading} aria-pressed={workDepartment === item.id} onClick={() => setWorkDepartment(workDepartment === item.id ? '' : item.id)}>View work<span className="sr-only"> in {item.name}</span></button>{data.canManage && <button className={button} disabled={busy || loading} aria-pressed={selected === item.id} onClick={() => { setAccess(null); setSelected(selected === item.id ? '' : item.id); setMemberOffset(0); }}>Manage {item.name}</button>}{data.canManage && <button className={button} disabled={busy || loading || operationBlocked || Boolean(uncertainRetirement)} onClick={() => { setRetirement(item); setRetirementNote(''); setRetirementConfirmed(false); setConfirm(null); setNotice(''); }}>{item.retiredAt ? 'Reopen department' : 'Retire department'}<span className="sr-only">: {item.name}</span></button>}</div>
          {item.retiredAt && <p className="w-full whitespace-pre-wrap break-words text-ink-secondary">Retired {new Date(item.retiredAt).toLocaleString()}. {item.retirementNote}</p>}
        </li>)}</ul>
        {(offset > 0 || data.hasMore) && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || loading || offset === 0} onClick={() => { setSelected(''); setOffset(value => value - 50); }}>Previous departments</button><button className={button} disabled={busy || loading || !data.hasMore} onClick={() => { setSelected(''); setOffset(value => value + 50); }}>Next departments</button></div>}
        {data.canManage && !operationBlocked && !uncertainRetirement && <form className="border-t border-line pt-3 space-y-2" onSubmit={event => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          if (creation.current?.name !== trimmed) creation.current = { id: crypto.randomUUID(), name: trimmed };
          const request = creation.current;
          void run(async () => { await companyApi.createDepartment(request.id, request.name); creation.current = null; setName(''); }, 'Department created. Choose Manage to set member access.');
        }}>
          <label className="block space-y-1"><span>New department name</span><input className={input} value={name} onChange={event => setName(event.target.value)} maxLength={120} required disabled={busy || loading} placeholder="For example, Accounts" /></label>
          <button className={button} disabled={busy || loading || !name.trim()}>Create department</button>
        </form>}
      </>}
      {data?.departments.filter(item => item.id === workDepartment).map(item => <CompanyDepartmentCases key={`${item.id}:${item.revision}:${caseRefresh}`} departmentId={item.id} operationBlocked={operationBlocked} onChanged={() => void load()} onOperationChange={() => void load()} />)}
      {access && !operationBlocked && !uncertainRetirement && <section aria-label={`${access.department.name} member access`} className="border-t border-line pt-3 space-y-3">
        <h4 className="font-medium">Who can use {access.department.name}</h4>
        <p className="text-ink-secondary">{access.department.retiredAt ? 'This department is retired. Existing access only permits viewing history. You can reduce or remove access here; reopen the department before granting more access.' : 'Read only lets a person view shared department records. Read and edit also lets them update those records. Office owners always manage department access.'}</p>
        <ul className="divide-y divide-line">{access.members.map(member => {
          const draft = drafts[member.id] ?? member.access;
          return <li key={member.id} className="py-3 space-y-2">
            <p className="break-words">{member.displayName}{member.role === 'owner' ? ' · Office owner' : ''}</p>
            {member.role === 'owner' ? <p className="text-ink-secondary">{access.department.retiredAt ? 'View history' : 'Read and edit'} · Managed by office ownership</p> : <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1"><select aria-label={`Access for ${member.displayName}`} className={input} value={draft} disabled={busy || loading} onChange={event => setDrafts(old => ({ ...old, [member.id]: event.target.value as DepartmentAccess }))}>{Object.entries(accessLabels).filter(([value]) => !access.department.retiredAt || value === member.access || value === 'none' || (member.access === 'write' && value === 'read')).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
              <button className={button} disabled={busy || loading || draft === member.access} onClick={() => draft === 'none' || (member.access === 'write' && draft === 'read') ? setConfirm({ id: member.id, name: member.displayName, access: draft }) : saveAccess(member.id, draft)}>Save access<span className="sr-only"> for {member.displayName}</span></button>
            </div>}
          </li>;
        })}</ul>
        {(memberOffset > 0 || access.hasMore) && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || loading || memberOffset === 0} onClick={() => setMemberOffset(value => value - 100)}>Previous members</button><button className={button} disabled={busy || loading || !access.hasMore} onClick={() => setMemberOffset(value => value + 100)}>Next members</button></div>}
      </section>}
      {confirm && !operationBlocked && <div role="group" aria-label="Confirm department access change" className="rounded-lg border border-agency p-3 space-y-2">
        <p className="font-medium">Change {confirm.name} to {accessLabels[confirm.access].toLowerCase()}?</p>
        <p>{confirm.access === 'none' ? 'They will lose access to this department immediately. Their office membership and private work stay unchanged.' : 'They will still see these records, but will no longer be able to edit them.'} Work already in progress may need an owner’s review.</p>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || loading} onClick={() => saveAccess(confirm.id, confirm.access)}>Confirm access change</button><button className={button} disabled={busy} onClick={() => setConfirm(null)}>Keep current access</button></div>
      </div>}
      {retirement && !operationBlocked && !uncertainRetirement && <form aria-label={retirement.retiredAt ? "Reopen department" : "Retire department"} className="rounded-lg border border-hold p-3 space-y-3" onSubmit={event => { event.preventDefault(); void retire(); }}>
        <h4 className="font-medium break-words">{retirement.retiredAt ? 'Reopen' : 'Retire'} {retirement.name}?</h4>
        <p>{retirement.retiredAt ? 'This allows new cases and changes again using existing member access. Review that access before reopening. Recorded closures stay closed, and no work is started automatically.' : 'This closes the department to new work and changes. Existing cases and review notes remain available as read-only history. Private work, office membership and other departments stay unchanged.'}</p>
        {!retirement.retiredAt && retirement.unresolvedCases > 0 ? <p role="status">{retirement.unresolvedCases} unfinished {retirement.unresolvedCases === 1 ? 'case needs' : 'cases need'} resolution first. Open View work, review held claims and close the remaining cases before retiring this department.</p> : <>
          <label className="block space-y-1">{retirement.retiredAt ? 'Reopening note' : 'Retirement note'}<textarea className={input + ' min-h-24'} value={retirementNote} maxLength={2048} required disabled={busy} onChange={event => setRetirementNote(event.target.value)} placeholder={retirement.retiredAt ? "Why is this department being reopened?" : "Why is this department being retired?"} /></label>
          <label className="flex min-h-11 items-start gap-2 py-2"><input type="checkbox" className="mt-1" checked={retirementConfirmed} disabled={busy} onChange={event => setRetirementConfirmed(event.target.checked)} /><span>{retirement.retiredAt ? 'I reviewed existing access and want this department to accept new work again.' : 'I reviewed the department and want to keep its records as read-only history.'}</span></label>
        </>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || loading || (!retirement.retiredAt && retirement.unresolvedCases > 0) || !retirementNote.trim() || !retirementConfirmed}>{retirement.retiredAt ? 'Confirm department reopening' : 'Confirm department retirement'}</button><button type="button" className={button} disabled={busy} onClick={() => { setRetirement(null); setRetirementNote(''); setRetirementConfirmed(false); }}>{retirement.retiredAt ? 'Keep department retired' : 'Keep department active'}</button></div>
      </form>}
      {uncertainRetirement && !operationBlocked && <div role="status" className="rounded-lg border border-hold p-3 space-y-2"><p>The department change may already be recorded. Retry the saved request to check its result without creating another decision.</p><button className={button} disabled={busy} onClick={() => void retire(uncertainRetirement)}>Check and retry department change</button></div>}
      {error && <p role="alert" className="text-danger">{error} No further changes will be sent until you refresh.</p>}
      <p role="status" className="text-ink-secondary">{busy ? 'Saving and checking office state…' : notice}</p>
      <button className={button} disabled={busy || loading} onClick={() => void load()}>Refresh departments</button>
    </div>
  </details>;
}
