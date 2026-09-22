import { useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import { companyApi } from '@/lib/company-api';
type OfflineDetachment = { id: string; companyId: string; memberId: string | null; detachedAt: string; remoteRevocationConfirmed: false };
type DepartmentPending = { requestId: string; departmentId: string; title: string; phase: 'pending' | 'confirmed' };
type Recovery = { remoteHost: boolean; pendingShare: { requestId: string; title: string; phase: 'pending' | 'confirmed' } | null; pendingDepartmentOperation: DepartmentPending | null; departure: 'leave' | 'disconnect' | null; enrollmentPending: boolean; offlineDetachments: { records: OfflineDetachment[]; hasMore: boolean } };
const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[14px] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
export function CompanyRecovery({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const [archives, setArchives] = useState<Array<{ requestId: string; title: string; outcome: string; archivedAt: string }> | null>(null);
  const [departmentArchives, setDepartmentArchives] = useState<Array<{ requestId: string; title: string; outcome: string; archivedAt: string }> | null>(null);
  const [departmentConfirm, setDepartmentConfirm] = useState(false);
  const [state, setState] = useState<Recovery | null>(null);
  const [hostCode, setHostCode] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false); const [detach, setDetach] = useState(false); const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const pending = useRef(false);
  const refreshVersion = useRef(0);
  const refresh = async () => {
    const version = ++refreshVersion.current;
    const next = await api('/api/company/local-state');
    if (!next || typeof next.remoteHost !== 'boolean' || typeof next.enrollmentPending !== 'boolean' || ![null, 'leave', 'disconnect'].includes(next.departure) ||
      !(next.pendingShare === null || (next.pendingShare && typeof next.pendingShare.requestId === 'string' && typeof next.pendingShare.title === 'string' && ['pending', 'confirmed'].includes(next.pendingShare.phase)))) throw new Error('Incomplete local recovery state.');
    const pendingDepartmentOperation = next.pendingDepartmentOperation ?? null;
    if (pendingDepartmentOperation && (typeof pendingDepartmentOperation.requestId !== 'string' || typeof pendingDepartmentOperation.departmentId !== 'string' || typeof pendingDepartmentOperation.title !== 'string' || !['pending', 'confirmed'].includes(pendingDepartmentOperation.phase))) throw new Error('The saved department update needs recovery.');
    const history = next.offlineDetachments ?? { records: [], hasMore: false };
    if (!Array.isArray(history.records) || typeof history.hasMore !== 'boolean' || history.records.some((record: OfflineDetachment) =>
      !record || typeof record.id !== 'string' || typeof record.companyId !== 'string' || !(record.memberId === null || typeof record.memberId === 'string') ||
      typeof record.detachedAt !== 'string' || !Number.isFinite(Date.parse(record.detachedAt)) || record.remoteRevocationConfirmed !== false)) throw new Error('Offline disconnect history could not be read. Existing records have been kept.');
    if (alive.current && version === refreshVersion.current) setState({ ...next, pendingDepartmentOperation, offlineDetachments: history });
  };
  useEffect(() => {
    alive.current = true;
    const check = () => { if (!pending.current) void refresh().catch(() => { if (alive.current) setError('Local recovery state could not be loaded. Existing records have been kept.'); }); };
    check(); const stop = companyApi.subscribeSession(check), stopDepartment = companyApi.subscribeDepartmentChanges(check); window.addEventListener('focus', check);
    return () => { alive.current = false; refreshVersion.current++; stop(); stopDepartment(); window.removeEventListener('focus', check); };
  }, []);
  useEffect(() => { if (state?.pendingShare || state?.pendingDepartmentOperation || state?.departure || state?.enrollmentPending || state?.offlineDetachments.records.length) setExpanded(true); }, [state?.pendingShare?.requestId, state?.pendingDepartmentOperation?.requestId, state?.departure, state?.enrollmentPending, state?.offlineDetachments.records.length]);
  useEffect(() => { setDepartmentConfirm(false); }, [state?.pendingDepartmentOperation?.requestId, state?.pendingDepartmentOperation?.phase]);
  useEffect(() => { setConfirm(false); }, [state?.pendingShare?.requestId, state?.pendingShare?.phase]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; refreshVersion.current++; setBusy(true); setError(''); setNotice('');
    try { await action(); if (!alive.current) return; setConfirm(false); setDepartmentConfirm(false); await refresh(); await onChanged(); }
    catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : 'Recovery could not be confirmed.');
        // Another window may already have acknowledged this request. Recheck
        // the local journal after rejection without implying the action worked.
        try { await refresh(); } catch { /* Keep the original failure visible. */ }
      }
    }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  if (!state) return error ? <p role="alert">{error}</p> : null;
  return <details className="rounded-lg border border-line p-3 space-y-3 text-[14px]" aria-busy={busy} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Connection and work recovery{state.offlineDetachments.records.length > 0 && <span className="block pt-1 text-[13px] font-normal text-ink-secondary">Past office access still needs checking</span>}</summary>
    {state.offlineDetachments.records.length > 0 && <section aria-label="Past office access" className="space-y-2 border-l-2 border-hold pl-3">
      <h3 className="font-medium">Disconnected here; office access is unconfirmed</h3>
      <p>This computer was disconnected while an office host could not be reached. Your membership or signed-in sessions at that office may still be active.</p>
      <p>Ask the owner of each office below to check your membership and remove any access you no longer need. Until they confirm it, treat that access as active. You can keep working privately or join another office.</p>
      <details><summary className="cursor-pointer min-h-11 py-3">Offline disconnect records ({state.offlineDetachments.records.length}{state.offlineDetachments.hasMore ? '+' : ''})</summary>
        <p className="text-ink-secondary">These encrypted records stay on this computer after restart. They record a local disconnect, not a confirmed removal of office access.</p>
        <ul className="mt-2 space-y-3">{state.offlineDetachments.records.map(record => <li key={record.id} className="border-t border-line pt-2">
          <p className="font-medium">Disconnected {new Date(record.detachedAt).toLocaleString()}</p>
          <p className="text-ink-secondary">Office access: not confirmed as removed</p>
          <details><summary className="cursor-pointer min-h-11 py-3">References for the office owner</summary><dl className="grid gap-1 text-[13px]"><dt>Office reference</dt><dd className="break-all">{record.companyId}</dd><dt>Member reference</dt><dd className="break-all">{record.memberId ?? 'No member reference was saved'}</dd></dl></details>
        </li>)}</ul>
        {state.offlineDetachments.hasMore && <p className="mt-2 text-ink-secondary">Showing the most recent 50 records. Older encrypted records are still kept on this computer.</p>}
      </details>
    </section>}
    {state?.enrollmentPending && <p>Finish joining by signing in with the username and password from your previous attempt.</p>}
    {state?.pendingShare && <>
      <p>“{state.pendingShare.title}” · {state.pendingShare.phase === 'confirmed' ? 'saved by the host' : 'remote result not yet confirmed'}. Open Shared work on Desk to continue the same request.</p>
      <button className={button} disabled={busy} onClick={() => setConfirm(true)}>Review local archive</button>
      {confirm && <div role="group" aria-label="Archive share recovery" className="space-y-2"><p>Archiving keeps an encrypted record here and releases this pending attempt. It does not cancel or delete anything on the office host. Check existing shared work before creating a replacement to avoid duplication.</p><button className={button} disabled={busy} onClick={() => void run(async () => { setArchives(null); await api('/api/company/outbox/archive', { method: 'POST', body: JSON.stringify({ requestId: state.pendingShare!.requestId, acknowledgeUnknown: true }) }); setNotice('Recovery record archived locally. The remote outcome has not been changed.'); })}>Archive with outcome recorded</button><button className={button} disabled={busy} onClick={() => setConfirm(false)}>Keep for retry</button></div>}
    </>}
    {state.pendingDepartmentOperation && <section aria-label="Saved department update recovery" className="space-y-2 border-l-2 border-hold pl-3">
      <p>“{state.pendingDepartmentOperation.title}” · {state.pendingDepartmentOperation.phase === 'confirmed' ? 'saved by the host' : 'result not yet confirmed'}. Open Departments to continue this saved request.</p>
      <button className={button} disabled={busy} onClick={() => setDepartmentConfirm(true)}>Review department update archive</button>
      {departmentConfirm && <div role="group" aria-label="Archive department update" className="space-y-2">
        <p>Use this if the request cannot be confirmed, such as after access is removed. Archiving keeps an encrypted receipt here and releases this attempt. It does not undo or cancel the office update. Check the department record with its owner before trying a replacement.</p>
        <button className={button} disabled={busy} onClick={() => void run(async () => {
          try { await api('/api/company/department-outbox/archive', { method: 'POST', body: JSON.stringify({ requestId: state.pendingDepartmentOperation!.requestId, acknowledgeUnknown: true }) }); }
          finally { companyApi.notifyDepartmentChange(); }
          setDepartmentArchives(null); setNotice('Department recovery receipt archived here. The office result has not been changed.');
        })}>Archive department outcome locally</button>
        <button className={button} disabled={busy} onClick={() => setDepartmentConfirm(false)}>Keep department request for retry</button>
      </div>}
    </section>}
    {state?.departure && <><p>{state.departure === 'leave' ? 'Leaving the office' : 'Disconnecting this computer'} is awaiting confirmation.</p><button className={button} disabled={busy} onClick={() => void run(() => companyApi.leaveOffice(state.departure === 'disconnect'))}>{state.departure === 'leave' ? 'Finish leaving' : 'Finish disconnecting'}</button></>}
    {state?.remoteHost && <details><summary className="cursor-pointer py-2">Host unavailable or replaced</summary><form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(async () => { await companyApi.connectHost(hostCode.trim(), true); setHostCode(''); setNotice('Replacement host saved. Sign in again as your existing office member.'); }); }}><p>After a verified host move or certificate renewal, use a new host code from your office owner. It must identify the same office. Resolve pending shared work and department updates first.</p><label className="block">Replacement host code<textarea value={hostCode} onChange={event => setHostCode(event.target.value)} required maxLength={12000} rows={3} className="mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2" /></label><button className={button} disabled={busy || !!state.pendingShare || !!state.pendingDepartmentOperation || !!state.departure}>Reconnect to replacement host</button></form><p className="mt-2">If this host cannot be reached, you can detach this computer. This does not revoke remote sessions or leave your membership; ask the office owner to remove access if needed.</p><button className={`${button} mt-2`} disabled={busy || !!state.pendingShare || !!state.pendingDepartmentOperation || state.departure === 'leave'} onClick={() => setDetach(true)}>Review offline disconnect</button>{detach && <div role="group" aria-label="Confirm offline disconnect" className="mt-2 space-y-2"><p>Remote sessions may remain active. Your private Bud stays here. Resolve pending shared work and department updates before reconnecting elsewhere.</p><button className={button} disabled={busy} onClick={() => void run(async () => { await companyApi.detachOffline(); if (alive.current) { setDetach(false); setNotice('Detached locally. Remote membership and session revocation were not confirmed.'); } })}>Disconnect locally; keep remote outcome unknown</button><button className={button} disabled={busy} onClick={() => setDetach(false)}>Keep connection</button></div>}</details>}
    <details onToggle={event => { if (event.currentTarget.open && !archives && !busy) void run(async () => { const result = await api('/api/company/outbox/archive'); if (!Array.isArray(result?.records)) throw new Error('Recovery history could not be read.'); if (alive.current) setArchives(result.records); }); }}><summary className="cursor-pointer py-2">Archived share receipts</summary><p className="mt-2">Most recent 50 records. Downloaded receipts contain the reviewed text and evidence; store them privately. An unknown result still needs checking with the office.</p>{archives?.length === 0 && <p className="mt-2">No archived share receipts.</p>}<ul className="mt-2 space-y-2">{archives?.map(record => <li key={record.requestId} className="space-y-1"><p>{record.title} · {record.outcome} · {new Date(record.archivedAt).toLocaleString()}</p><button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api('/api/company/outbox/archive/export', { method: 'POST', body: JSON.stringify({ requestId: record.requestId }) }); const url = URL.createObjectURL(new Blob([JSON.stringify(result.record, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `realbud-share-receipt-${record.requestId}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); if (alive.current) setNotice('Receipt download requested. Its remote outcome has not changed.'); })}>Download private receipt</button></li>)}</ul></details>
    <details onToggle={event => {
      if (event.currentTarget.open && !departmentArchives && !busy) void run(async () => {
        const result = await api('/api/company/department-outbox/archive');
        if (!Array.isArray(result?.records) || result.records.some((record: { requestId?: unknown; title?: unknown; outcome?: unknown; archivedAt?: unknown }) => !record || typeof record.requestId !== 'string' || typeof record.title !== 'string' || !['saved', 'unknown'].includes(String(record.outcome)) || typeof record.archivedAt !== 'string' || !Number.isFinite(Date.parse(record.archivedAt)))) throw new Error('Department recovery history could not be read.');
        if (alive.current) setDepartmentArchives(result.records);
      });
    }}>
      <summary className="cursor-pointer min-h-11 py-3">Archived department update receipts</summary>
      <p>Most recent 50 records. Downloads contain the saved request and review notes; store them privately. An unknown result still needs checking with the office.</p>
      {departmentArchives?.length === 0 && <p className="mt-2">No archived department updates.</p>}
      <ul className="mt-2 space-y-2">{departmentArchives?.map(record => <li key={record.requestId} className="space-y-1">
        <p className="break-words">{record.title} · {record.outcome === 'saved' ? 'saved by the host' : 'outcome unknown'} · {new Date(record.archivedAt).toLocaleString()}</p>
        <button className={button} disabled={busy} onClick={() => void run(async () => {
          const result = await api('/api/company/department-outbox/archive/export', { method: 'POST', body: JSON.stringify({ requestId: record.requestId }) });
          if (!result?.record) throw new Error('The archived department receipt could not be loaded.');
          const url = URL.createObjectURL(new Blob([JSON.stringify(result.record, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `realbud-department-receipt-${record.requestId}.json`;
          document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
          if (alive.current) setNotice('Department receipt download requested. The office result has not changed.');
        })}>Download private department receipt</button>
      </li>)}</ul>
    </details>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <p role="status" className="text-ink-secondary">{busy ? 'Checking recovery…' : notice}</p>
    <button className={button} disabled={busy} onClick={() => void run(refresh)}>Refresh local recovery</button>
  </details>;
}
