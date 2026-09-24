import { useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import { PRIVATE_BACKUP_MIN_PASSPHRASE, PRIVATE_BACKUP_MAX_PASSPHRASE } from '@shared/private-workspace-backup';
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_MAX_BYTES, PRIVATE_BACKUP_TRANSFER_ERRORS, parsePrivateBackupTransferPage, type PrivateBackupTransferOperation as Operation } from '@shared/private-backup-transfers';
import { backupStatus, restartBackupService, validBackupPassphrase, type BackupReceipt, type BackupStatus } from '@/lib/private-backup';
import { PrivateBackupTransferClient, privateBackupTransferHttp, requestPrivateBackupDownload } from '@/lib/private-backup-transfer';
import { backupWelcomeBlocked, createBackupWelcomeApi } from '@/lib/backup-welcome';
import type { OnboardingState } from '@shared/onboarding';
import { Card } from './SettingsPrimitives';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'mt-1 min-h-11 w-full min-w-0 rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-agency';
const active = new Set(['capturing', 'sealing', 'checking', 'staging', 'applying']);
const labels: Record<Operation['phase'], string> = { capturing: 'Copying your records', sealing: 'Encrypting your backup', ready: 'Ready to download', uploading: 'Copying backup to RealBud', uploaded: 'Ready to check', checking: 'Checking backup contents', reviewed: 'Ready for your review', staging: 'Preparing restore', staged: 'Restart required', applying: 'Restoring after restart', completed: 'Restore completed', interrupted: 'Ready to continue', failed: 'Needs attention', cancelled: 'Removed', expired: 'Expired' };
const size = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
function Contents({ receipt }: { receipt: BackupReceipt }) {
  return <div className="space-y-3 text-sm">
    <p>Created {new Date(receipt.createdAt).toLocaleString()} · {receipt.fileCount} saved {receipt.fileCount === 1 ? 'file' : 'files'} · {receipt.recordCount} workflow {receipt.recordCount === 1 ? 'record' : 'records'}</p>
    <p className="text-ink-secondary">Unencrypted contents: {receipt.plainBytes < 1024 * 1024 ? `${(receipt.plainBytes / 1024).toFixed(1)} KB` : `${(receipt.plainBytes / 1024 / 1024).toFixed(1)} MB`}. The downloaded file is encrypted.</p>
    {[['Included', receipt.included], ['Not included', receipt.excluded], ['After restore', receipt.restoreChanges]].map(([title, items]) => <div key={title as string}><h5 className="font-medium">{title as string}</h5><ul className="list-disc pl-5">{(items as string[]).map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul></div>)}
    <details><summary className="min-h-11 cursor-pointer">Backup identifiers</summary><p className="break-all text-xs">Workspace {receipt.workspaceId} · digest {receipt.digest}</p></details>
  </div>;
}

export function BackupWelcomeAction({ onboarding, blocked, busy, onBack }: { onboarding: OnboardingState | null; blocked: string | null; busy: boolean; onBack: () => void }) {
  if (onboarding?.stage !== 'recovery') return null;
  return <div className="space-y-2 text-sm">
    <button className={button} disabled={busy || !!blocked} onClick={onBack}>Back to welcome</button>
    <p className="text-ink-secondary">{blocked || 'Continue setup without restoring a backup. Your original files and saved backup copies stay unchanged.'}</p>
  </div>;
}

export function PrivateWorkspaceBackup() {
  const [status, setStatus] = useState<BackupStatus | null>(null), [items, setItems] = useState<Operation[]>([]), [selectedId, setSelectedId] = useState<string | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [exportPhrase, setExportPhrase] = useState(''), [repeat, setRepeat] = useState(''), [importPhrase, setImportPhrase] = useState(''), [file, setFile] = useState<File | null>(null), [confirmed, setConfirmed] = useState(false);
  const client = useRef<PrivateBackupTransferClient | null>(null), pending = useRef(false), mounted = useRef(true), controller = useRef<AbortController | null>(null);
  const welcome = useRef(createBackupWelcomeApi((path, init) => api(path, init, { timeoutMs: 15_000 })));
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const selected = items.find(item => item.id === selectedId), staged = status?.staged === true;
  const update = (op: Operation) => { if (mounted.current) setItems(current => [op, ...current.filter(item => item.id !== op.id)]); };
  const refresh = async (more = false) => {
    const [state, raw, savedSetup] = await Promise.all([api('/api/private-backup', undefined, { timeoutMs: 15_000 }), privateBackupTransferHttp.request(`${PRIVATE_BACKUP_TRANSFER_API}/operations?limit=20${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' }), welcome.current.read().catch(() => null)]);
    const page = parsePrivateBackupTransferPage(raw); if (!page) throw new Error('Saved backup progress could not be verified.');
    client.current = new PrivateBackupTransferClient(page.workspaceId);
    if (mounted.current) {
      setStatus(backupStatus(state)); setCursor(page.nextCursor); setOnboarding(savedSetup);
      setItems(current => more ? [...current, ...page.items.filter(item => !current.some(saved => saved.id === item.id))] : page.items);
      if (!selectedId) setSelectedId(page.items.find(item => ['staged', 'staging', 'reviewed'].includes(item.phase))?.id ?? null);
    }
  };
  useEffect(() => { mounted.current = true; void refresh().catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Backup status is unavailable.'); }); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (!selected || !active.has(selected.phase) || busy) return;
    const timer = setTimeout(() => { void client.current?.get(selected.id).then(op => { update(op); if (op.phase === 'staged') void refresh(); }).catch(() => { if (mounted.current) setError('Saved progress is unavailable. Check backup status before continuing.'); }); }, 1500);
    return () => clearTimeout(timer);
  }, [selected, busy]);
  const run = async (work: (client: PrivateBackupTransferClient, signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return; pending.current = true; const abort = new AbortController(); controller.current = abort; setBusy(true); setError(''); setNotice('');
    try { if (!client.current) await refresh(); if (!client.current) throw new Error('Backup storage is unavailable.'); await work(client.current, abort.signal); }
    catch (cause) { if (mounted.current) { if (abort.signal.aborted) setNotice('Stopped waiting here. RealBud keeps the saved progress; select the same backup to continue.'); else setError(cause instanceof Error ? cause.message : 'The result was not confirmed. Check saved progress before continuing.'); } }
    finally { pending.current = false; if (controller.current === abort) controller.current = null; if (mounted.current) setBusy(false); }
  };
  const finish = async (c: PrivateBackupTransferClient, id: string, signal: AbortSignal) => {
    const result = await c.poll(id, { signal, onOperation: update }); update(result);
    if (result.error) throw new Error(PRIVATE_BACKUP_TRANSFER_ERRORS[result.error.code]); return result;
  };
  const download = async (c: PrivateBackupTransferClient, op: Operation, signal: AbortSignal) => { requestPrivateBackupDownload(await c.downloadTicket(op, signal)); setNotice('Download requested. Check that the encrypted file was saved, and keep its passphrase separately.'); };
  const readyUpload = selected?.kind === 'upload' && !!selected.artifact && ['uploaded', 'failed', 'interrupted'].includes(selected.phase);
  const canRestart = Boolean(window.ogb?.serviceStatus && window.ogb?.serviceStop && window.ogb?.serviceStart);
  return <section aria-label="Private workspace backup" aria-busy={busy}><Card title="Private workspace backup" subtitle="Keep an encrypted copy of your private business records, protected by a passphrase you choose.">
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">Includes your private business files and workflow history. Connected-account credentials, company membership, Bud conversations and worker sign-ins are excluded. Shared office records use the separate office-host backup.</p>
      <details className="text-sm text-ink-secondary"><summary className="min-h-11 cursor-pointer content-center">Backup size and support</summary><p>Encrypted backups can be up to 1 GB. Older RealBud backup files are supported. RealBud checks the complete backup and available space before restoring. If a limit is reached, your original records stay intact.</p></details>
      <button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(); setNotice('Backup and restore status checked.'); })}>Check backup status</button>
      <BackupWelcomeAction onboarding={onboarding} blocked={backupWelcomeBlocked(status, items)} busy={busy} onBack={() => void run(async (_client, signal) => {
        if (!onboarding) throw new Error('Check your saved setup before continuing.');
        await welcome.current.back(onboarding, signal);
        if (mounted.current) { window.location.hash = ''; window.location.reload(); }
      })} />
      {!status && !error && <p role="status" className="text-sm">Checking backup availability…</p>}
      {status && !staged && <p className="text-sm text-ink-secondary">{status.reason}</p>}
      {status?.completionWarning && <p role="alert" className="rounded-lg border border-hold p-3 text-sm text-hold">{status.completionWarning}</p>}
      {!staged && status?.completed && <section aria-label="Completed private restore" className="rounded-lg border border-agency p-3 space-y-2 text-sm"><h4 className="font-medium">Last restore completed</h4><p>Restored {new Date(status.completed.restoredAt).toLocaleString()}. Review agency setup, reconnect sources and review paused schedules and approvals before running work.</p><details><summary className="min-h-11 cursor-pointer">View restored backup details</summary><Contents receipt={status.completed.receipt} /></details></section>}
      {staged && <div role="status" className="rounded-lg border border-hold p-3 space-y-3 text-sm"><h4 className="font-medium">{status.completionWarning ? 'Restore needs attention' : 'Restore staged — restart required'}</h4><p>Your workspace is held while RealBud finishes this restore. Prepared records are not loaded into the running workspace yet.</p>{canRestart ? <button className={button} disabled={busy || !!status.completionWarning} onClick={() => void run(async () => {
        const current = backupStatus(await api('/api/private-backup')); if (!current.staged || current.receipt?.digest !== status.receipt?.digest || current.completionWarning) throw new Error('Check the saved restore before restarting.');
        await restartBackupService({ serviceStatus: () => window.ogb!.serviceStatus!(), serviceStop: () => window.ogb!.serviceStop!(), serviceStart: () => window.ogb!.serviceStart!() }); window.location.reload();
      })}>Restart service to finish restore</button> : <p>Use the desktop’s service controls to stop and start RealBud, then reload this window. Closing a window alone does not restart the service.</p>}</div>}
      {!!items.length && <section aria-label="Saved backup operations" className="rounded-lg border border-line p-3 space-y-3"><h4 className="font-medium">Saved backup progress</h4><p className="text-sm text-ink-secondary">Continue a transfer or download a completed backup after reopening this screen.</p><div className="space-y-2">{items.map(op => <button key={op.id} className={`${button} block w-full text-left ${selectedId === op.id ? 'border-agency bg-agency/5' : ''}`} disabled={busy} aria-pressed={selectedId === op.id} onClick={() => { setSelectedId(op.id); setConfirmed(false); setImportPhrase(''); setError(''); }}><span className="font-medium">{op.kind === 'export' ? 'Backup' : 'Restore file'} · {labels[op.phase]}</span><span className="block text-xs text-ink-secondary">{new Date(op.createdAt).toLocaleString()} · {op.id.slice(0, 8)}</span></button>)}</div>{cursor && <button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(true); })}>Load more saved operations</button>}</section>}
      {selected && <section aria-label="Selected backup progress" className="rounded-lg border border-line p-3 space-y-3 text-sm"><h4 className="font-medium">{labels[selected.phase]}</h4><p>{selected.progress.totalBytes ? `${size(selected.receivedBytes ?? selected.progress.completedBytes)} of ${size(selected.progress.totalBytes)}` : 'Preparing a consistent copy of your records.'}</p>{selected.progress.totalBytes !== null && <progress className="w-full" aria-label="Backup transfer progress" max={selected.progress.totalBytes} value={selected.receivedBytes ?? selected.progress.completedBytes} />}{selected.error && <p role="alert" className="text-hold">{PRIVATE_BACKUP_TRANSFER_ERRORS[selected.error.code]}</p>}
        {selected.phase === 'ready' && <button className={button} disabled={busy} onClick={() => void run((c, signal) => download(c, selected, signal))}>Download saved backup</button>}
        {selected.phase === 'staging' && !busy && <button className={button} onClick={() => void run(async (c, signal) => { update(await c.stage(selected, signal)); await refresh(); })}>Finish preparing restore</button>}
        {selected.canCancel && <button className={button} disabled={busy} onClick={() => void run(async (c, signal) => { update(await c.cancel(selected.id, signal)); setNotice('Temporary backup files removed. Your workspace records and original file are unchanged.'); })}>Remove temporary copy</button>}
      </section>}
      {!staged && <>
        <form aria-label="Create private backup" className="rounded-lg border border-line p-3 space-y-3" onSubmit={event => { event.preventDefault(); void run(async (c, signal) => {
          if (!validBackupPassphrase(exportPhrase) || exportPhrase !== repeat) throw new Error('Use a matching backup passphrase in both fields.');
          const id = selected?.kind === 'export' && ['failed', 'interrupted'].includes(selected.phase) ? selected.id : crypto.randomUUID(); setSelectedId(id);
          update(await c.startExport(id, exportPhrase, signal)); setExportPhrase(''); setRepeat(''); const ready = await finish(c, id, signal); if (ready.phase === 'ready') await download(c, ready, signal);
        }); }}><h4 className="font-medium">Download a backup</h4><p className="text-sm text-ink-secondary">Choose at least {PRIVATE_BACKUP_MIN_PASSPHRASE} characters. RealBud does not keep this passphrase.</p><label className="block text-sm">New backup passphrase<input aria-label="New backup passphrase" type="password" autoComplete="new-password" minLength={PRIVATE_BACKUP_MIN_PASSPHRASE} maxLength={PRIVATE_BACKUP_MAX_PASSPHRASE} className={field} value={exportPhrase} disabled={busy || !status} onChange={event => setExportPhrase(event.target.value)} /></label><label className="block text-sm">Repeat backup passphrase<input aria-label="Repeat private backup passphrase" type="password" autoComplete="new-password" maxLength={PRIVATE_BACKUP_MAX_PASSPHRASE} className={field} value={repeat} disabled={busy || !status} onChange={event => setRepeat(event.target.value)} /></label><button className={button} disabled={busy || !status || !validBackupPassphrase(exportPhrase) || exportPhrase !== repeat}>Download encrypted private backup</button></form>
        <form aria-label="Preview private backup" className="rounded-lg border border-line p-3 space-y-3" onSubmit={event => { event.preventDefault(); void run(async (c, signal) => {
          if (!validBackupPassphrase(importPhrase) || !file && !readyUpload) throw new Error('Choose a backup and enter its passphrase.'); setConfirmed(false);
          let op = readyUpload ? selected! : null;
          if (!op) { const id = selected?.kind === 'upload' && selected.phase === 'uploading' ? selected.id : crypto.randomUUID(); setSelectedId(id); update(await c.startUpload(id, file!.size, signal)); op = await c.uploadFile(id, file!, { signal, onOperation: update }); update(op); }
          update(await c.preview(op.id, importPhrase, op.artifact!.archiveDigest, signal)); setImportPhrase(''); await finish(c, op.id, signal); setNotice('Backup contents checked. Previewing has not changed your business records.');
        }); }}><h4 className="font-medium">Preview a backup for restore</h4><p className="text-sm text-ink-secondary">Restore requires a fresh workspace. To resume a saved upload, select it above and choose the same original file.</p><label className="block text-sm">Encrypted private backup file<input aria-label="Encrypted private backup file" type="file" accept=".realbud-backup,.json,application/json,application/octet-stream" className={field} disabled={busy || !status} onChange={event => { const chosen = event.target.files?.[0] ?? null; setConfirmed(false); if (chosen && (chosen.size < 1 || chosen.size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES)) { setError('Choose a non-empty backup up to 1 GB.'); setFile(null); return; } setFile(chosen); if (selected?.kind !== 'upload' || selected.phase !== 'uploading') setSelectedId(null); }} /></label><p className="text-xs text-ink-secondary">Maximum file size: 1 GB. {file && `Selected: ${file.name}`}{readyUpload && ' The complete uploaded copy is ready to check.'}</p><label className="block text-sm">Restore passphrase<input aria-label="Restore private backup passphrase" type="password" autoComplete="off" maxLength={PRIVATE_BACKUP_MAX_PASSPHRASE} className={field} value={importPhrase} disabled={busy || !file && !readyUpload} onChange={event => { setImportPhrase(event.target.value); setConfirmed(false); }} /></label><button className={button} disabled={busy || !file && !readyUpload || !validBackupPassphrase(importPhrase)}>Preview private backup contents</button></form>
        {selected?.phase === 'reviewed' && selected.preview && <section aria-label="Private backup preview" className="rounded-lg border border-agency p-3 space-y-3"><h4 className="font-medium">Review before restoring</h4><Contents receipt={selected.preview} />{status?.canRestore && status.bootstrap ? <><label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I checked this backup and want to restore its business records into this fresh workspace. I understand schedules and approvals must be reviewed again.</label><button className={button} disabled={busy || !confirmed} onClick={() => void run(async (c, signal) => { update(await c.stage(selected, signal)); setFile(null); setImportPhrase(''); setConfirmed(false); await refresh(); setNotice('Restore prepared. Restart the service to load the restored workspace.'); })}>Stage reviewed restore</button></> : <p role="status" className="text-sm text-hold">{status?.reason || 'Check restore availability before continuing.'}</p>}</section>}
      </>}
      {busy && <button className={button} onClick={() => controller.current?.abort()}>Stop waiting on this screen</button>}
      {error && <p role="alert" className="text-sm text-danger break-words">{error}</p>}
      <p role="status" className="text-sm text-ink-secondary">{busy ? 'Saving and checking backup progress…' : notice}</p>
    </div>
  </Card></section>;
}
