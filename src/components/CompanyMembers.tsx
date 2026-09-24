import { useEffect, useRef, useState } from 'react';
import type { CompanyManagement, CompanyStatus } from '@shared/company-api';
import { companyApi } from '@/lib/company-api';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-[13px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
export function CompanyMembers({ status, onChanged }: { status: CompanyStatus; onChanged: () => Promise<unknown> }) {
  const [data, setData] = useState<CompanyManagement | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ label: string; detail: string; action: () => Promise<unknown> } | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const load = async (page = offset) => {
    const current = ++generation.current;
    const epoch = companyApi.sessionVersion();
    const next = await companyApi.management(page);
    if (active.current && current === generation.current && epoch === companyApi.sessionVersion()) { setData(next); setConfirm(null); }
  };
  useEffect(() => {
    active.current = true;
    const stop = companyApi.subscribeSession(() => { setData(null); setConfirm(null); });
    void load(offset).catch(() => { if (active.current) { setData(null); setError('Office administration could not be loaded. Check the host connection and refresh.'); } });
    return () => { active.current = false; generation.current++; stop(); };
  }, [offset]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      await action();
      if (!active.current) return;
      setConfirm(null); setNotice('Saved. Checking the current office state…');
      await onChanged();
      if (epoch === companyApi.sessionVersion()) await load();
      if (active.current) setNotice('Office state updated.');
    } catch (cause) {
      if (active.current) { setData(null); setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed. Refresh before trying again.'); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const owner = status.member?.role === 'owner';
  return <details className="rounded-lg border border-line p-3" open={!!status.departurePending || undefined}>
    <summary className="cursor-pointer text-[13px] font-medium text-ink">{owner ? 'Members, invitations and ownership' : 'Membership and ownership'}</summary>
    <div className="mt-3 space-y-4 text-[13px]" aria-busy={busy}>
      {owner && data && <>
        <h4 className="font-medium">Members</h4>
        <ul className="space-y-3">{data.members.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <span className="min-w-0 break-words">{member.displayName} · {member.active ? member.role : 'access removed'}</span>
          {member.active && member.role === 'member' && <div className="flex flex-wrap gap-2">
            <button disabled={busy} className={button} onClick={() => setConfirm({ label: `Remove ${member.displayName}`, detail: 'This immediately revokes their office sessions. Their private work stays on their computer. Shared records remain, and unfinished work may need reassignment.', action: () => companyApi.revokeMember(member.id) })}>Remove access</button>
            <button disabled={busy} className={button} onClick={() => setConfirm({ label: `Offer ownership to ${member.displayName}`, detail: 'They must accept within 24 hours. You remain owner until then. Acceptance makes you a member and cancels unused invitations. Private work does not transfer.', action: () => companyApi.offerOwnership(member.id) })}>Offer ownership</button>
          </div>}
        </li>)}</ul>
        <h4 className="font-medium">Invitations</h4>
        {data.invitations.length === 0 && <p className="text-ink-secondary">No invitations on this page.</p>}
        <ul className="space-y-2">{data.invitations.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
          <span>{invitation.displayName} · {invitation.revokedAt ? 'cancelled' : invitation.redeemedAt ? 'used' : invitation.expiresAt && Date.parse(invitation.expiresAt) < Date.now() ? 'expired' : 'pending'}</span>
          {!invitation.revokedAt && !invitation.redeemedAt && <button disabled={busy} className={button} onClick={() => void run(() => companyApi.revokeInvitation(invitation.id))}>Cancel invitation</button>}
        </li>)}</ul>
        <div className="flex gap-2"><button className={button} disabled={busy || offset === 0} onClick={() => { setData(null); setOffset(value => Math.max(0, value - 100)); }}>Previous page</button><button className={button} disabled={busy || !data.hasMore} onClick={() => { setData(null); setOffset(value => value + 100); }}>Next page</button></div>
      </>}
      {data?.transfer && <div className="rounded-lg border border-line p-3 space-y-2">
        <p>{data.transfer.toMemberId === status.member?.id ? 'You have been offered ownership of this office.' : 'Ownership has been offered. You remain owner until the recipient accepts.'}</p>
        {data.transfer.toMemberId === status.member?.id && <button className={button} disabled={busy} onClick={() => setConfirm({ label: 'Accept office ownership', detail: 'You will manage members and invitations. The previous owner becomes a member. Hosting and private work remain on their existing computers.', action: () => companyApi.acceptOwnership(data.transfer!.id) })}>Review acceptance</button>}
        <button className={button} disabled={busy} onClick={() => void run(() => companyApi.cancelOwnership(data.transfer!.id))}>Cancel offer</button>
      </div>}
      <div className="border-t border-line pt-3 space-y-2">
        {owner && <p className="text-ink-secondary">Transfer ownership and wait for acceptance before leaving. The host computer continues serving the office.</p>}
        {data?.unresolvedWork && <p className="text-ink-secondary">Resolve your open Shared work on Desk before leaving: finish or close your shared items, and finish or reassign items assigned to you. For held department work, ask the office owner to open Departments and access → View work and record a recovery decision. Then refresh administration here.</p>}
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || owner || !data || data.unresolvedWork} onClick={() => setConfirm({ label: 'Leave this office', detail: 'Your membership and office sessions will be revoked. Your private Bud, local book and conversations remain. Shared office records are kept.', action: () => companyApi.leaveOffice() })}>Leave office</button>
          {status.remoteHost && <button className={button} disabled={busy} onClick={() => setConfirm({ label: 'Disconnect this computer', detail: 'This ends the current office session and detaches the host from this private workspace. Your membership and other computer sessions remain. Your private work stays here.', action: () => companyApi.leaveOffice(true) })}>Disconnect this computer</button>}
        </div>
      </div>
      {confirm && <div role="group" aria-label={confirm.label} className="rounded-lg border border-agency p-3 space-y-2"><p className="font-medium">{confirm.label}</p><p>{confirm.detail}</p><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void run(confirm.action)}>Confirm</button><button className={button} disabled={busy} onClick={() => setConfirm(null)}>Keep current setup</button></div></div>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <p role="status" className="text-ink-secondary">{busy ? 'Checking office state…' : notice}</p>
      <button className={button} disabled={busy} onClick={() => void run(() => load())}>Refresh administration</button>
    </div>
  </details>;
}
