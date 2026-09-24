import { useEffect, useRef, useState } from 'react';
import type { CompanyStatus } from '@shared/company-api';
import { companyApi } from '@/lib/company-api';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-[13px] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[14px]';
type HostState = { mode: 'active' | 'standby' | 'retired'; busy: boolean; lastBackup?: { createdAt: string }; restored?: { restoredAt: string; companyId: string; backupCreatedAt: string; sourceRetired: boolean } };
function parseState(value: Record<string, unknown>): HostState {
  if (!['active', 'standby', 'retired'].includes(String(value.mode)) || typeof value.busy !== 'boolean') throw new Error('The host recovery response was incomplete.');
  return value as HostState;
}

export function CompanyHostRecovery({ status, onChanged }: { status: CompanyStatus; onChanged: () => Promise<unknown> }) {
  const [host, setHost] = useState<HostState | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [retire, setRetire] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true); const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = async () => { const next = parseState(await companyApi.hostRecovery()); if (active.current) setHost(next); };
  const run = async (action: () => Promise<string>, clearSecrets = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const message = await action();
      if (!active.current) return;
      setNotice(message); if (clearSecrets) { setPassphrase(''); setRepeat(''); } setStopped(false);
      await refresh(); await onChanged();
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Host recovery could not be confirmed. Check status before retrying.'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const exportBackup = () => run(async () => {
    if (passphrase !== repeat) throw new Error('The backup passphrases do not match.');
    const result = await companyApi.hostRecovery('backup', { passphrase, retireSource: retire });
    const backup = result.backup as { format?: string } | undefined;
    const receipt = result.receipt as { sha256?: string; createdAt?: string } | undefined;
    if (backup?.format !== 'realbud-office' || !receipt?.sha256) throw new Error('Backup generation was not confirmed. Check host status.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `realbud-office-${new Date().toISOString().slice(0, 10)}-${receipt.sha256.slice(0, 8)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return `${retire ? 'Source host retired. ' : ''}Encrypted backup generated and download requested. Verify the file was saved, keep a separate copy, and test restoring it. This does not prove an off-computer backup exists.`;
  }, true);
  const restore = () => run(async () => {
    if (!file || file.size > 48 * 1024 * 1024) throw new Error('Choose an office backup of at most 48 MB.');
    let backup: unknown;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error('The selected file is not valid backup JSON.'); }
    const result = await companyApi.hostRecovery('restore', { passphrase, backup });
    if (result.mode !== 'standby') throw new Error('Restore status was not confirmed. Check host status before continuing.');
    setFile(null);
    return 'Office data restored and held. Sign in using the existing owner’s credentials. Stop every previous host, then complete activation here. Members will need new host codes and sign-in sessions.';
  }, true);
  if (!status.hostRecoveryAvailable || status.remoteHost) return null;
  return <details className="rounded-lg border border-line p-3" onToggle={event => {
    if (event.currentTarget.open && !host && !busy) void run(async () => { await refresh(); return ''; });
  }}>
    <summary className="cursor-pointer text-[13px] font-medium">Host backup and recovery</summary>
    <div className="mt-3 space-y-3 text-[13px]" aria-busy={busy}>
      <p>Service administrator sign-in is required. Office backups include all records on the office host, including access-restricted records and sign-in data. They do not include anyone’s private Bud, local property book, files or connected accounts.</p>
      <p>Host state: <strong>{status.hostMode ?? host?.mode ?? 'Check status'}</strong>. Built-in backups support up to 32 MB of office data and 100,000 records. Larger offices require an assisted database backup.</p>
      {host?.lastBackup && <p>Last generated: {new Date(host.lastBackup.createdAt).toLocaleString()}. Verify its saved copy separately.</p>}
      {host?.restored && <p>Restore completed: {new Date(host.restored.restoredAt).toLocaleString()}. Backup taken: {new Date(host.restored.backupCreatedAt).toLocaleString()}. Changes after that backup are not included. {host.restored.sourceRetired ? 'The source was retired before this backup.' : 'This was a regular snapshot; verify that no later office work needs recovery before cutover.'}</p>}
      {status.member?.role === 'owner' && <form onSubmit={event => { event.preventDefault(); void exportBackup(); }} className="space-y-3">
        <h4 className="font-medium">Download an encrypted office backup</h4>
        <label className="block">Backup passphrase<input type="password" className={field} value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={16} maxLength={256} autoComplete="new-password" required /></label>
        <label className="block">Repeat backup passphrase<input type="password" className={field} value={repeat} onChange={event => setRepeat(event.target.value)} minLength={16} maxLength={256} autoComplete="new-password" required /></label>
        <p>Keep the passphrase separately. RealBud cannot recover it.</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={retire} onChange={event => setRetire(event.target.checked)} disabled={busy} className="mt-1" /><span>Move this office: retire this host before making the final backup. Collaboration stops here and stays held after restart.</span></label>
        <button className={button} disabled={busy || !passphrase || passphrase !== repeat}>{retire ? 'Retire host and generate backup' : 'Generate backup'}</button>
      </form>}
      {!status.configured && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void restore(); }}>
        <h4 className="font-medium">Restore to this empty host</h4>
        <label className="block">Encrypted office backup<input type="file" accept=".json,application/json" className={`${field} min-w-0 max-w-full`} onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={busy} required /></label>
        <label className="block">Backup passphrase<input type="password" className={field} value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={16} maxLength={256} autoComplete="off" required /></label>
        <p>Restore preserves the office identity but revokes old sessions and invitations. This computer gets its own network certificate. It stays on hold until the owner completes cutover.</p>
        <button className={button} disabled={busy || !file || !passphrase}>Restore and hold</button>
        {(status.hostMode ?? host?.mode) === 'standby' && <button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await companyApi.hostRecovery('reset-empty', {}); return 'Restore cancelled on this empty host. You can create a new office or try another backup.'; })}>Cancel restore on empty host</button>}
      </form>}
      {(status.hostMode ?? host?.mode) !== 'active' && status.member?.role === 'owner' && <div className="border-t border-line pt-3 space-y-3">
        <h4 className="font-medium">Activate this office host</h4>
        <p>Office: {status.company?.name}. Confirm the old computer is shut down or its office service is retired. This network cannot automatically verify an unreachable host.</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} disabled={busy} className="mt-1" /><span>I have verified that every previous host for this office has stopped serving it.</span></label>
        <button className={button} disabled={busy || !stopped} onClick={() => void run(async () => { await companyApi.hostRecovery('activate', { companyId: status.company!.id, originalHostStopped: true }); return 'This host is active. Enable joining and issue a new host code to each member.'; })}>Activate verified host</button>
      </div>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <p role="status">{busy ? 'Working on host recovery. Keep this app open…' : notice}</p>
      <button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(); return 'Recovery status checked.'; })}>Check host recovery</button>
    </div>
  </details>;
}
