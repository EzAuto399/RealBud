import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanyManagement, CompanyStatus } from '@shared/company-api';
import { companyApi } from '@/lib/company-api';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-[13px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const LOAD_ERROR = 'Office administration could not be loaded. Check the host connection and refresh.';
type Invitation = CompanyManagement['invitations'][number];
const invitationState = (invitation: Invitation, now = Date.now()) => invitation.revokedAt ? 'cancelled' : invitation.redeemedAt ? 'used' : invitation.expiresAt && Date.parse(invitation.expiresAt) < now ? 'expired' : 'pending';
/**
 * `roster` is the owner's people list on the office card's main view; `membership`
 * (ownership transfer, leaving, disconnecting) lives in Office settings.
 * `refreshKey` changes when the parent confirms fresh office status or creates an invitation.
 */
export function CompanyMembers({ status, refreshKey, onChanged, view = 'membership', onCount }: { status: CompanyStatus; refreshKey?: number; onChanged: () => Promise<unknown>; view?: 'roster' | 'membership'; onCount?: (active: number, more: boolean) => void }) {
  const epoch = useSyncExternalStore(companyApi.subscribeSession, companyApi.sessionVersion, companyApi.sessionVersion);
  const scope = JSON.stringify([status.company?.id, status.member?.id, status.member?.role, epoch]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [loaded, setLoaded] = useState<{ scope: string; data: CompanyManagement } | null>(null);
  const data = loaded?.scope === scope ? loaded.data : null;
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  type Confirmation = { label: string; detail: string; action: () => Promise<unknown> };
  const [confirmation, setConfirmation] = useState<(Confirmation & { scope: string }) | null>(null);
  const confirm = confirmation?.scope === scope ? confirmation : null;
  const setConfirm = (value: Confirmation | null) => setConfirmation(value ? { ...value, scope } : null);
  const active = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const seenRefreshKey = useRef(refreshKey);
  const load = async (page = offset, keepConfirm = false) => {
    const current = ++generation.current;
    const epoch = companyApi.sessionVersion();
    const next = await companyApi.management(page);
    if (active.current && currentScope.current === scope && current === generation.current && epoch === companyApi.sessionVersion()) {
      setLoaded({ scope, data: next }); if (!keepConfirm) setConfirm(null);
      if (page === 0) onCount?.(next.members.filter(member => member.active).length, next.hasMore);
    }
  };
  useEffect(() => {
    active.current = true;
    setLoaded(null); setConfirmation(null); setError(''); setNotice('');
    const stop = companyApi.subscribeSession(() => { setLoaded(null); setConfirmation(null); });
    void load(offset).catch(() => { if (active.current && currentScope.current === scope) { setLoaded(null); setError(LOAD_ERROR); } });
    return () => { active.current = false; generation.current++; stop(); };
  }, [offset, scope]);
  // Quiet reload: keeps an open confirmation (for this same scope) and the last list if the host is briefly unreachable.
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    if (pending.current) return;
    void load(offset, true).then(() => { if (active.current && currentScope.current === scope) setError(current => current === LOAD_ERROR ? '' : current); }, () => undefined);
  }, [refreshKey]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current || !active.current || currentScope.current !== scope) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = companyApi.sessionVersion();
    try {
      await action();
      if (!active.current || currentScope.current !== scope) return;
      setConfirm(null); setNotice('Saved. Checking the current office state…');
      await onChanged();
      if (active.current && currentScope.current === scope && epoch === companyApi.sessionVersion()) await load();
      if (active.current && currentScope.current === scope) setNotice('Office state updated.');
    } catch (cause) {
      if (active.current && currentScope.current === scope) { setLoaded(null); setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed. Refresh before trying again.'); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const owner = status.member?.role === 'owner';
  const waiting = data?.invitations.filter(invitation => ['pending', 'expired'].includes(invitationState(invitation))) ?? [];
  const confirmationCard = confirm && <div role="group" aria-label={confirm.label} className="rounded-lg border border-agency p-3 space-y-2"><p className="font-medium">{confirm.label}</p><p>{confirm.detail}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(confirm.action)}>{confirm.label}</button><button className={button} disabled={busy} onClick={() => setConfirm(null)}>Keep current setup</button></div></div>;
  const feedback = <>{error && <p role="alert" className="text-danger">{error}</p>}<p role="status" className="text-ink-secondary">{busy ? 'Checking office state…' : notice}</p></>;
  if (view === 'roster') return <section aria-label="People in this office" className="space-y-3 text-[13px]" aria-busy={busy}>
    <h4 className="font-medium text-ink">People in this office</h4>
    {data && <>
      <ul className="space-y-2">{data.members.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
        <span className="min-w-0 break-words">{member.displayName} · {member.active ? member.role : 'access removed'}</span>
        {member.active && member.role === 'member' && <button disabled={busy} className={button} onClick={() => setConfirm({ label: `Remove ${member.displayName}`, detail: 'This immediately revokes their office sessions. Their private work stays on their computer. Shared records remain, and unfinished work may need reassignment.', action: () => companyApi.revokeMember(member.id) })}>Remove access<span className="sr-only"> for {member.displayName}</span></button>}
      </li>)}</ul>
      {/* Used and cancelled invitations are history; only ones still waiting (or lapsed) need the owner. */}
      {waiting.length > 0 && <h5 className="font-medium text-ink">Invitations</h5>}
      <ul className="space-y-2">{waiting.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>{invitation.displayName} · {invitationState(invitation)}</span>
        {invitationState(invitation) === 'pending' && <button disabled={busy} className={button} onClick={() => void run(() => companyApi.revokeInvitation(invitation.id))}>Cancel invitation</button>}
      </li>)}</ul>
      {(offset > 0 || data.hasMore) && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || offset === 0} onClick={() => { setLoaded(null); setOffset(value => Math.max(0, value - 100)); }}>Previous page</button><button className={button} disabled={busy || !data.hasMore} onClick={() => { setLoaded(null); setOffset(value => value + 100); }}>Next page</button></div>}
    </>}
    {confirmationCard}
    {feedback}
    {error && <button className={button} disabled={busy} onClick={() => void run(() => load())}>Try again</button>}
  </section>;
  return <details className="rounded-lg border border-line p-3" open={!!status.departurePending || undefined}>
    <summary className="cursor-pointer text-[13px] font-medium text-ink">Membership and ownership</summary>
    <div className="mt-3 space-y-4 text-[13px]" aria-busy={busy}>
      {owner && data && <>
        <h4 className="font-medium">Transfer ownership</h4>
        <p className="text-ink-secondary">The person you choose must accept within 24 hours. You stay owner until then.</p>
        {data.members.some(member => member.active && member.role === 'member') ? <ul className="space-y-2">{data.members.filter(member => member.active && member.role === 'member').map(member => <li key={member.id}>
          <button disabled={busy} className={button} onClick={() => setConfirm({ label: `Offer ownership to ${member.displayName}`, detail: 'They must accept within 24 hours. You remain owner until then. Acceptance makes you a member and cancels unused invitations. Private work does not transfer.', action: () => companyApi.offerOwnership(member.id) })}>Offer ownership to {member.displayName}</button>
        </li>)}</ul> : <p className="text-ink-secondary">Invite someone first. Ownership can only go to a current member.</p>}
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
      {confirmationCard}
      {feedback}
      <button className={button} disabled={busy} onClick={() => void run(() => load())}>Refresh administration</button>
    </div>
  </details>;
}
