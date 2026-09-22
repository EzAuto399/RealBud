import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanyManagement, CompanyStatus } from '@shared/company-api';
import type { CompanyPortalBinding, CompanyPortalBindingPage } from '@shared/company-portal';
import { COMPANY_PORTAL_ORIGIN } from '@shared/company-portal';
import { companyApi, departmentMutationUncertain } from '@/lib/company-api';
import { encodeCompanyPortalTarget, isCompanyPortalOperation, type CompanyPortalOperation } from '@/lib/company-portal-code';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-[13px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'w-full min-h-10 rounded-lg border border-line bg-transparent p-2 text-[13px]';
const phases = { pending: 'Waiting for member identity', candidate: 'Owner review and member confirmation needed', confirmed: 'Identity mapped', revoked: 'Mapping disconnected' };
export function CompanyPortalBindingsCard({ status }: { status: CompanyStatus }) {
  const companyId = status.company!.id, memberId = status.member!.id;
  const hostReady = status.networkEnabled === true || (status.remoteHost === true && status.transport === 'encrypted-company');
  const storageKey = `realbud.company-portal-operation.v1:${companyId}:${memberId}`;
  const [page, setPage] = useState<CompanyPortalBindingPage | null>(null);
  const [members, setMembers] = useState<CompanyManagement | null>(null);
  const [memberOffset, setMemberOffset] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState('');
  const [saved, setSaved] = useState<CompanyPortalOperation | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [revokeId, setRevokeId] = useState('');
  const [note, setNote] = useState('');
  const [now, setNow] = useState(Date.now());
  const active = useRef(true), lock = useRef(false), generation = useRef(0);
  const load = useCallback(async (position = offset) => {
    const epoch = companyApi.sessionVersion(), current = ++generation.current;
    const result = await companyApi.portalBindings(position, 20);
    if (active.current && epoch === companyApi.sessionVersion() && current === generation.current) {
      if (result.bindings.some(row => row.mapTarget.companyId !== companyId)) throw new Error('The host returned another company. Check company status.');
      setPage(result); setReviewed({});
    }
  }, [offset, companyId]);
  useEffect(() => {
    active.current = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (!isCompanyPortalOperation(value)) throw new Error();
        setSaved(value);
      }
      setReady(true);
    } catch { setError('Saved mapping recovery could not be read. Keep this tab open and contact support before changing a mapping.'); }
    const stop = companyApi.subscribeSession(() => {
      generation.current++; setPage(null); setMembers(null); setSaved(null); setReady(false); setProofs({}); setReviewed({});
      setError('Your company session changed. Reopen company settings after signing in.');
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active.current = false; generation.current++; stop(); clearInterval(timer); };
  }, [storageKey]);
  useEffect(() => {
    void load().catch(cause => { if (active.current) { setPage(null); setError(cause instanceof Error ? cause.message : 'Mapping status is unavailable.'); } });
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    const epoch = companyApi.sessionVersion();
    if (page?.canManage) void companyApi.management(memberOffset).then(value => {
      if (!cancelled && active.current && epoch === companyApi.sessionVersion()) setMembers(value);
    }).catch(() => { if (!cancelled) { setMembers(null); setError('Member choices could not be loaded. Refresh or check the host connection.'); } });
    return () => { cancelled = true; };
  }, [page?.canManage, memberOffset]);
  async function run(operation: CompanyPortalOperation) {
    if (lock.current || !ready) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      if (!isCompanyPortalOperation(operation)) throw new Error('Paste the complete 64-character proof code and check the required fields.');
      // Persist before any request. A tab storage failure must not create an unrecoverable write.
      sessionStorage.setItem(storageKey, JSON.stringify(operation)); setSaved(operation);
      const result = await companyApi.portalBindingOperation(operation);
      if (!active.current || epoch !== companyApi.sessionVersion()) return;
      if (result.mapTarget.companyId !== companyId) throw new Error('The response did not match this company. Refresh before retrying.');
      sessionStorage.removeItem(storageKey); setSaved(null); setProofs({}); setReviewed({}); setRevokeId('');
      setPage(previous => ({ bindings: [result, ...(previous?.bindings ?? []).filter(row => row.id !== result.id)].slice(0,20), offset, hasMore: previous?.hasMore ?? false, canManage: previous?.canManage ?? false }));
      setNotice(result.phase === 'candidate' ? 'Identity received. Review the person below, then ask that same member for a separate confirmation proof.' : result.phase === 'confirmed' ? 'Identity mapping confirmed. Department work still needs separate permissions.' : result.phase === 'revoked' ? 'This identity mapping is disconnected.' : 'Mapping created. Give this member the first code below.');
    } catch (cause) {
      if (active.current && epoch === companyApi.sessionVersion()) {
        if (!departmentMutationUncertain(cause)) {
          try { await load(); sessionStorage.removeItem(storageKey); setSaved(null); } catch { /* Keep exact recovery until current host state can be checked. */ }
        }
        setError(cause instanceof Error ? cause.message : 'The reply did not arrive. Retry the saved request or refresh its status.');
      }
    } finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function refresh() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await load(); }
    catch (cause) { setPage(null); setError(cause instanceof Error ? cause.message : 'Mapping status is unavailable.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied. Share this only with the member and the company owner involved in this mapping.'); }
    catch { setError('Clipboard access is unavailable. Select and copy the complete code from the field.'); }
  }
  const disabled = busy || !ready || !!saved;
  const targetCode = (row: CompanyPortalBinding) => encodeCompanyPortalTarget(row.phase === 'candidate' ? row.confirmTarget : row.mapTarget);
  return <details className="rounded-lg border border-line p-3">
    <summary className="cursor-pointer text-[13px] font-medium text-ink">Company member website identity</summary>
    <div className="mt-3 space-y-4 text-[13px]" aria-busy={busy}>
      <p>Connect a company member to their verified RealBud website identity with the member and owner present. This mapping does not enable a department worker or change private work permissions.</p>
      {!hostReady && <p className="rounded-lg border border-line p-3">The owner must first enable office joining in Company connection settings. A current encrypted host identity is required even for an office with one person. If already enabled, refresh company status and check the host certificate.</p>}
      <ol className="list-decimal space-y-1 pl-5"><li>The owner selects a member and shares the mapping code.</li><li>The member verifies the code on the website, then enters the identity proof in their own company session.</li><li>The owner checks the identity. That same member provides a new confirmation proof before the owner finishes.</li></ol>
      <p>Use <a className="underline break-all" href={`${COMPANY_PORTAL_ORIGIN}/account/company-portal`} target="_blank" rel="noreferrer">realbud.app/account/company-portal</a>. Never paste a password or API key.</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {notice && <p role="status" className="text-ink-secondary">{notice}</p>}
      {saved && <div className="rounded-lg border border-agency p-3 space-y-2"><h4 className="font-medium">Saved request needs a confirmed reply</h4><p>This tab kept your {saved.action} request. Refresh can show the latest state; retry sends the same operation and proof, without creating a replacement.</p><button className={button} disabled={busy || !ready} onClick={() => void run(saved)}>Retry saved mapping request</button></div>}
      <button className={button} disabled={busy} onClick={() => void refresh()}>Refresh mappings</button>
      {page?.canManage && <fieldset disabled={disabled || !hostReady} className="space-y-2 rounded-lg border border-line p-3"><legend className="px-1 font-medium">1. Choose the company member</legend>
        <label className="block" htmlFor="portal-binding-member">Active member</label><select id="portal-binding-member" className={input} value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a member…</option>{members?.members.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.displayName} · {m.role}</option>)}</select>
        {members && <div className="flex flex-wrap gap-2"><button className={button} disabled={disabled || memberOffset === 0} onClick={() => { setMembers(null); setSelected(''); setMemberOffset(n => Math.max(0,n-100)); }}>Previous members</button><button className={button} disabled={disabled || !members.hasMore} onClick={() => { setMembers(null); setSelected(''); setMemberOffset(n => n+100); }}>More members</button></div>}
        <button className={button} disabled={disabled || !hostReady || !members?.members.some(m => m.active && m.id === selected)} onClick={() => void run({action:'begin',body:{version:1,requestId:crypto.randomUUID(),memberId:selected}})}>Create member mapping</button>
        <p className="text-ink-secondary">A new mapping requires a deliberate choice. Codes expire after ten minutes and never renew automatically.</p>
      </fieldset>}
      {page && page.bindings.length === 0 && <p>No identity mappings on this page.</p>}
      {page?.bindings.map(row => {
        const pending = row.phase === 'pending' || row.phase === 'candidate';
        const target = row.phase === 'candidate' ? row.confirmTarget : row.mapTarget;
        const expired = Date.parse(target.expiresAt) <= now;
        return <article key={row.id} className="rounded-lg border border-line p-3 space-y-3" aria-label={`Website identity for ${row.memberName}`}>
          <h4 className="font-medium break-words">{row.memberName}</h4><p>{phases[row.phase]}{!row.current && row.phase !== 'revoked' ? ' · Not current; refresh and review before continuing' : ''}</p>
          <dl className="space-y-1"><dt className="text-ink-secondary">Company</dt><dd className="break-all">{status.company!.name} · {companyId}</dd><dt className="text-ink-secondary">Member ID</dt><dd className="break-all">{row.memberId}</dd><dt className="text-ink-secondary">Host certificate fingerprint</dt><dd className="break-all font-mono text-xs">{target.certificateDigest}</dd></dl>
          {row.person && <div className="rounded-lg bg-surface p-3"><p className="font-medium">Verified candidate</p><p className="break-all">{row.person.email}</p><p className="break-words">{row.person.agencyLabel || 'No agency label provided'}</p></div>}
          {pending && <>
            <p>{row.phase === 'candidate' ? '3. Ask the same member to verify this separate confirmation code on the website.' : '2. The named member verifies this code on the website, then enters the returned proof here in their own company session.'}</p>
            <label className="block" htmlFor={`target-${row.id}`}>{row.phase === 'candidate' ? 'Member confirmation code' : 'Member mapping code'}</label><textarea id={`target-${row.id}`} className={`${input} break-all font-mono text-xs`} value={targetCode(row)} rows={3} readOnly />
            <button className={button} disabled={busy || expired} onClick={() => void copy(targetCode(row))}>Copy {row.phase === 'candidate' ? 'confirmation' : 'mapping'} code</button>
            <p>{expired ? 'This code expired. Disconnect this mapping, then deliberately create a new one.' : `Code expires ${new Date(target.expiresAt).toLocaleString()}. Return the website proof before its displayed expiry.`}</p>
            {(row.phase === 'candidate' ? page.canManage : row.memberId === memberId) && !expired && row.current && <fieldset disabled={disabled} className="space-y-2"><legend className="sr-only">Receive member proof</legend>
              {row.phase === 'candidate' && <label className="flex items-start gap-2"><input type="checkbox" checked={!!reviewed[row.id]} onChange={e => setReviewed(v => ({...v,[row.id]:e.target.checked}))} /><span>I checked that this email and agency belong to {row.memberName}, and the member is confirming this exact company and host.</span></label>}
              <label className="block" htmlFor={`proof-${row.id}`}>{row.phase === 'candidate' ? 'Fresh member confirmation proof' : 'Member identity proof'}</label><input id={`proof-${row.id}`} className={input} type="password" autoComplete="off" spellCheck={false} maxLength={64} value={proofs[row.id] ?? ''} onChange={e => setProofs(v => ({...v,[row.id]:e.target.value}))} />
              <button className={button} disabled={disabled || !/^[a-f0-9]{64}$/.test(proofs[row.id] ?? '') || (row.phase === 'candidate' && !reviewed[row.id])} onClick={() => void run({action:row.phase === 'candidate' ? 'confirm' : 'accept',body:{version:1,bindingId:row.id,requestId:crypto.randomUUID(),expectedRevision:row.revision,proofHandle:proofs[row.id]}})}>{row.phase === 'candidate' ? 'Confirm reviewed identity mapping' : 'Record my verified website identity'}</button>
            </fieldset>}
          </>}
          {row.phase !== 'revoked' && (page.canManage || row.memberId === memberId) && (revokeId === row.id ? <div className="space-y-2"><p>Disconnect this identity mapping? Connecting again requires the attended steps. Existing work records remain.</p><label className="block" htmlFor={`note-${row.id}`}>Reason (optional)</label><input id={`note-${row.id}`} className={input} value={note} maxLength={2048} onChange={e => setNote(e.target.value)} /><button className={button} disabled={disabled} onClick={() => void run({action:'revoke',body:{version:1,bindingId:row.id,requestId:crypto.randomUUID(),expectedRevision:row.revision,note:note.trim()}})}>Disconnect identity mapping</button>{' '}<button className={button} disabled={busy} onClick={() => setRevokeId('')}>Keep mapping</button></div> : <button className={button} disabled={disabled} onClick={() => { setRevokeId(row.id); setNote(''); }}>Review disconnect</button>)}
        </article>;
      })}
      {page && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || offset === 0} onClick={() => { setPage(null); setOffset(n => Math.max(0,n-20)); }}>Previous mappings</button><button className={button} disabled={busy || !page.hasMore} onClick={() => { setPage(null); setOffset(n => n+20); }}>More mappings</button></div>}
    </div>
  </details>;
}
