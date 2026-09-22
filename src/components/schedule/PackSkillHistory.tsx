import { useEffect, useRef, useState } from 'react';
import type { PackSkillArchiveConfirmation, PackSkillArchivePreview, PackSkillHistoryPage, PackSkillHistorySummary, PackSkillRevertPreview } from '@shared/customer-packs';
import { api } from '@/state/store';
import { InstructionComparison } from './InstructionComparison';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
type Run = (work: () => Promise<void>) => Promise<void>;
const confirmation = (preview: PackSkillArchivePreview): PackSkillArchiveConfirmation => ({ expectedInstalledDigest: preview.installedDigest, expectedInstalledRevision: preview.installedRevision,
  expectedActiveDigest: preview.activeDigest, expectedActiveRevision: preview.activeRevision, expectedHead: preview.head, expectedPreviewDigest: preview.previewDigest });
function useReviewFocus(key: string) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus({ preventScroll: true }); region.current?.scrollIntoView({ block: 'start' }); }, [key]);
  return region;
}
export function SkillArchiveReview({ preview, busy, apply, cancel }: { preview: PackSkillArchivePreview; busy: boolean; apply: () => void; cancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false), region = useReviewFocus(preview.previewDigest);
  return <section ref={region} tabIndex={-1} aria-label="Review instruction history archival" className="rounded border border-agency p-4 space-y-3 focus-visible:outline-2 focus-visible:outline-agency">
    <h5 className="font-medium">Archive older revisions of {preview.name}</h5>
    <p className="text-sm">Move {preview.archive.length} older {preview.archive.length === 1 ? 'revision' : 'revisions'} into this computer’s private archive. Every listed revision stays available for review and revert, and is included in your private workspace backup.</p>
    <div className="grid gap-4 sm:grid-cols-2"><div><h6 className="font-medium text-sm">Move into the archive</h6><ul className="mt-2 max-h-56 overflow-auto list-disc pl-5 text-sm">{preview.archive.map(item => <li key={item.revision}>Revision {item.revision} · {item.reason}</li>)}</ul></div>
      <div><h6 className="font-medium text-sm">Keep immediately available</h6><ul className="mt-2 list-disc pl-5 text-sm">{preview.keep.map(item => <li key={item.revision}>Revision {item.revision}{item.active ? ' · Active' : ''}</li>)}</ul></div></div>
    <p className="text-sm">Current instructions, plan approvals, schedules and saved work stay in place.</p>
    {!!preview.conflicts.length && <div role="alert" className="text-sm text-hold"><ul className="list-disc pl-5">{preview.conflicts.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || !preview.canArchive} onChange={e => setConfirmed(e.target.checked)} /><span>I reviewed which instruction revisions will move into the private archive.</span></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !confirmed || !preview.canArchive} onClick={apply}>Archive reviewed instruction history</button><button className={button} disabled={busy} onClick={cancel}>Cancel archival</button></div>
  </section>;
}
export function SkillRevertReview({ preview, busy, apply, cancel }: { preview: PackSkillRevertPreview; busy: boolean; apply: () => void; cancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false), region = useReviewFocus(preview.reviewDigest);
  return <section ref={region} tabIndex={-1} aria-label="Review instruction revert" className="rounded border border-agency p-4 space-y-3 focus-visible:outline-2 focus-visible:outline-agency">
    <h5 className="font-medium">Revert {preview.name} to revision {preview.target.revision}</h5>
    <p className="text-sm">Review the full text before replacing active revision {preview.activeRevision}. The selected text becomes a new revision; earlier history stays available.</p>
    <InstructionComparison current={preview.current} proposed={preview.proposed} />
    <p className="text-sm">This pauses the pack’s plans, clears their approval and turns schedules off. Review the plans again before running them.</p>
    {!!preview.conflicts.length && <div role="alert" className="text-sm text-hold"><ul className="list-disc pl-5">{preview.conflicts.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || !preview.canRevert} onChange={e => setConfirmed(e.target.checked)} /><span>I reviewed the current and selected instructions and understand that the plans will need fresh approval.</span></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !confirmed || !preview.canRevert} onClick={apply}>Confirm reviewed revert and pause plans</button><button className={button} disabled={busy} onClick={cancel}>Cancel revert</button></div>
  </section>;
}
export function PackSkillHistory({ summary, busy, run, reload, notice }: { summary: PackSkillHistorySummary; busy: boolean; run: Run; reload: () => Promise<void>; notice: (message: string) => void }) {
  const [page, setPage] = useState<PackSkillHistoryPage | null>(null), [archive, setArchive] = useState<PackSkillArchivePreview | null>(null), [revert, setRevert] = useState<PackSkillRevertPreview | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const route = `/api/customer-packs/${summary.packId}/skills/${summary.skillId}`;
  const mutate = (action: string, body: unknown, message: string) => void run(async () => {
    try { await api(`${route}/${action}`, { method: 'POST', body: JSON.stringify(body) }, { timeoutMs: 35_000 }); }
    finally { if (alive.current) { setArchive(null); setRevert(null); setPage(null); } await reload(); }
    notice(message);
  });
  const browse = (older = false) => void run(async () => {
    if (alive.current) { setArchive(null); setRevert(null); }
    try {
      const body = older && page ? { installationRevision: page.installationRevision, head: page.head, sourceDigest: page.sourceDigest, cursor: page.nextCursor } : {};
      const result: PackSkillHistoryPage = await api(`${route}/history`, { method: 'POST', body: JSON.stringify(body) });
      if (alive.current) setPage(result);
    } catch (error) { if (alive.current) setPage(null); await reload(); throw error; }
  });
  return <article aria-label={`${summary.name} instruction history`} className="rounded border border-line p-3 space-y-3">
    <div><h4 className="font-medium">{summary.name}</h4><p className="mt-1 text-sm text-ink-secondary">{summary.packId} · Active revision {summary.activeRevision} · {summary.hotRevisions} recent · {summary.archivedRevisions} archived</p></div>
    {summary.pendingArchive && <div role="alert" className="rounded border border-hold p-3 text-sm space-y-2"><p>A reviewed instruction archive was interrupted. Current instructions and all retained revisions are preserved. Finish recovery before updating or running this pack.</p><button className={button} disabled={busy} onClick={() => mutate('resume-archive', summary.pendingArchive, 'Instruction history archival is confirmed. Current instructions and plan approvals are unchanged.')}>Resume instruction archival</button></div>}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !!summary.pendingArchive} onClick={() => browse()}>{page ? 'Show newest revisions' : 'Browse saved revisions'}</button>
      {summary.hotRevisions > 2 && <button className={button} disabled={busy || !!summary.pendingArchive} onClick={() => void run(async () => { if (alive.current) { setArchive(null); setRevert(null); } try { const result = await api(`${route}/archive-preview`, { method: 'POST', body: '{}' }); if (alive.current) setArchive(result); } catch (error) { await reload(); throw error; } })}>Review instruction archival</button>}</div>
    {page && <div className="space-y-3"><p className="text-sm text-ink-secondary">Showing {page.revisions.length} saved revisions. Open a revision to review its complete text before reverting.</p><ul className="divide-y divide-line text-sm">{page.revisions.map(item => <li key={`${item.revision}/${item.digest}`} className="py-3 space-y-2"><p>Revision {item.revision} · {item.active ? 'Active' : 'Retained'}</p><p className="text-ink-secondary break-words">{item.reason}</p>{!item.active && <button className={button} disabled={busy || !!summary.pendingArchive} onClick={() => void run(async () => {
        try { const result = await api(`${route}/revert-preview`, { method: 'POST', body: JSON.stringify({ installationRevision: page.installationRevision, head: page.head, sourceDigest: page.sourceDigest, revision: item.revision, digest: item.digest }) }); if (alive.current) { setArchive(null); setRevert(result); } }
        catch (error) { if (alive.current) setRevert(null); await reload(); throw error; }
      })}>Review revert to revision {item.revision}</button>}</li>)}</ul>{page.nextCursor && <button className={button} disabled={busy || !!summary.pendingArchive} onClick={() => browse(true)}>Show older revisions</button>}</div>}
    {archive && <SkillArchiveReview key={archive.previewDigest} preview={archive} busy={busy} cancel={() => setArchive(null)} apply={() => mutate('archive', confirmation(archive), 'Instruction history archived. Every saved revision remains available, and current instructions and approvals are unchanged.')} />}
    {revert && <SkillRevertReview key={revert.reviewDigest} preview={revert} busy={busy} cancel={() => setRevert(null)} apply={() => mutate('revert', { ...revert.selection, expectedReviewDigest: revert.reviewDigest }, 'Instructions reverted as a new revision. Review the paused plans again.')} />}
  </article>;
}
