import { useEffect, useRef, useState } from 'react';
import type { CustomerPackArchivePreview, CustomerPackArchivedHistory, CustomerPackChangePreview, CustomerPackHistoryItem, CustomerPackInstallation } from '@shared/customer-packs';
import { api } from '@/state/store';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
type Run = (work: () => Promise<void>) => Promise<void>;
export function CustomerPackArchiveReview({ preview, busy, apply, cancel }: { preview: CustomerPackArchivePreview; busy: boolean; apply: () => void; cancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus({ preventScroll: true }); region.current?.scrollIntoView({ block: 'start' }); }, [preview.previewDigest]);
  return <section ref={region} tabIndex={-1} aria-label="Review pack history archival" className="rounded-lg border border-agency p-4 space-y-3 focus-visible:outline-2 focus-visible:outline-agency">
    <h5 className="font-medium">Archive older configurations of {preview.title}</h5>
    <p className="text-sm">Save {preview.archive.length} older configurations in this computer’s private archive to make room for future updates. You can still browse them, download their published definitions and preview a rollback. Include the archive in your private workspace backup.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <div><h6 className="font-medium text-sm">Move into the archive</h6><ul className="list-disc pl-5 text-sm">{preview.archive.map(item => <li key={item.installationRevision}>Configuration {item.installationRevision} · version {item.revision}</li>)}</ul></div>
      <div><h6 className="font-medium text-sm">Keep in recent history</h6><ul className="list-disc pl-5 text-sm">{preview.keep.map(item => <li key={item.installationRevision}>Configuration {item.installationRevision} · version {item.revision}</li>)}</ul></div>
    </div>
    <p className="text-sm text-ink-secondary">Your current plans, approvals, schedules and saved work stay in place. This operation keeps every listed configuration.</p>
    {preview.conflicts.length > 0 && <div role="alert" className="text-sm text-hold"><ul className="list-disc pl-5">{preview.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul></div>}
    <label className="flex min-h-11 gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || !preview.canArchive} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed which configurations will move into the private archive.</span></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !preview.canArchive || !confirmed} onClick={apply}>Archive reviewed history</button><button className={button} disabled={busy} onClick={cancel}>Cancel archival</button></div>
  </section>;
}

export function CustomerPackHistory({ pack, busy, run, reload, showChange, notice }: {
  pack: CustomerPackInstallation; busy: boolean; run: Run; reload: () => Promise<void>;
  showChange: (preview: CustomerPackChangePreview) => void; notice: (message: string) => void;
}) {
  const [preview, setPreview] = useState<CustomerPackArchivePreview | null>(null);
  const [older, setOlder] = useState<CustomerPackArchivedHistory | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setPreview(null); setOlder(null); }, [pack.digest, pack.installationRevision, pack.archivedHistory?.head, pack.pendingArchive?.previewDigest]);
  const held = !!pack.pendingChange || !!pack.pendingArchive;
  const route = `/api/customer-packs/${pack.id}`;
  const checked = (previewDigest: string) => ({ expectedInstalledDigest: pack.digest, expectedInstalledRevision: pack.installationRevision, expectedPreviewDigest: previewDigest });
  const mutate = (operation: 'archive' | 'resume-archive', previewDigest: string) => void run(async () => {
    try { await api(`${route}/${operation}`, { method: 'POST', body: JSON.stringify(checked(previewDigest)) }, { timeoutMs: 35_000 }); }
    finally { if (alive.current) setPreview(null); await reload(); }
    if (alive.current) notice('History archival is confirmed. Every saved configuration remains available, and future pack updates have room to proceed.');
  });
  const entries = (items: CustomerPackHistoryItem[]) => <ul className="space-y-3 mt-3">{items.map(prior => <li key={prior.installationRevision} className="space-y-2">
    <p className="text-sm break-words">{prior.title} · version {prior.revision} · saved configuration {prior.installationRevision}</p>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || held} onClick={() => void run(async () => {
      const result = await api(`${route}/rollback-preview`, { method: 'POST', body: JSON.stringify({ installationRevision: prior.installationRevision }) });
      if (alive.current) showChange(result);
    })}>Preview rollback to configuration {prior.installationRevision}</button><button className={button} disabled={busy} onClick={() => void run(async () => {
      const definition = await api(`${route}/history-export`, { method: 'POST', body: JSON.stringify({ installationRevision: prior.installationRevision }) });
      const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `realbud-${pack.id}-v${prior.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}>Download prior pack definition</button></div>
  </li>)}</ul>;
  if (!pack.history?.length && !pack.archivedHistory && !pack.pendingArchive) return null;
  return <div className="space-y-3">
    {pack.pendingArchive && <div role="alert" className="rounded border border-hold p-3 space-y-2 text-sm"><p>A reviewed history archive needs recovery. The saved decision keeps the original configurations until its archive is verified.</p><button className={button} disabled={busy} onClick={() => mutate('resume-archive', pack.pendingArchive!.previewDigest)}>Resume reviewed history archival</button></div>}
    <details><summary className="min-h-11 cursor-pointer text-sm">Previous configurations and rollback</summary>
      <p className="text-sm">Rollback is a new reviewed change. Your saved work stays in place; approvals and schedules are not restored. Portable downloads contain the published pack definition, not customer records or local edits.</p>
      <p className="mt-2 text-sm text-ink-secondary">{pack.history?.length ?? 0} recent configurations · {pack.archivedHistory?.configurations ?? 0} archived configurations.</p>
      {(pack.history?.length ?? 0) > 2 && <button className={`${button} mt-3`} disabled={busy || held} onClick={() => void run(async () => {
        const result = await api(`${route}/archive-preview`, { method: 'POST', body: '{}' }); if (alive.current) setPreview(result);
      })}>Review history archival</button>}
      {entries(pack.history ?? [])}
      {pack.archivedHistory && <div className="mt-4 space-y-3 border-t border-line pt-3"><h5 className="font-medium text-sm">Archived configurations</h5>
        <button className={button} disabled={busy} onClick={() => void run(async () => {
          const result = await api(`${route}/archived-history`, { method: 'POST', body: '{}' }); if (alive.current) setOlder(result);
        })}>{older ? 'Show newest archive' : 'Browse archived configurations'}</button>
        {older && <>{entries(older.history)}{older.nextCursor && <button className={button} disabled={busy} onClick={() => void run(async () => {
          const result = await api(`${route}/archived-history`, { method: 'POST', body: JSON.stringify({ head: older.head, cursor: older.nextCursor }) }); if (alive.current) setOlder(result);
        })}>Show older archive</button>}</>}
      </div>}
    </details>
    {preview && <CustomerPackArchiveReview key={preview.previewDigest} preview={preview} busy={busy} cancel={() => setPreview(null)} apply={() => mutate('archive', preview.previewDigest)} />}
  </div>;
}
