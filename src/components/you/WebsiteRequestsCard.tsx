import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import { Card } from '../SettingsPrimitives';
import type { OfficeLinkStatus } from '../../../server/office-link';
import type { SavedWebsiteRequest, WebsiteRequestPreview, WebsiteRequestsStatus } from '../../../server/website-requests';
import type { WorkflowRecord } from '../../../server/workflow-database';
import type { WebsiteCommandPhase } from '@shared/website-commands';

type RequestRow = WorkflowRecord<SavedWebsiteRequest>;
type Snapshot = { status: WebsiteRequestsStatus; records: RequestRow[]; next: number | null };
type Review = { id: string; revision: number; preview: WebsiteRequestPreview };
const button = 'pm-control min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const activePhases: WebsiteCommandPhase[] = ['queued', 'delivered', 'accepted', 'running', 'interrupted'];
const phaseLabels: Record<WebsiteCommandPhase, string> = {
  queued: 'Waiting for this computer', delivered: 'Waiting for your review', accepted: 'Approved · checking start', running: 'Preparing',
  completed: 'Prepared', 'needs-review': 'Prepared · needs attention', partial: 'Partly prepared', failed: 'Could not finish',
  interrupted: 'Interrupted · check the saved outcome', rejected: 'Declined', cancelled: 'Cancelled', expired: 'Expired', stale: 'Work plan changed',
};
const date = (value: string) => new Date(value).toLocaleString();
const safeError = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
const rowId = (row: RequestRow) => row.value.envelope.id;

function ExactRequestReview({ review, row, enabled, busy, close, decide }: {
  review: Review; row: RequestRow; enabled: boolean; busy: boolean; close: () => void; decide: (choice: 'approve' | 'reject') => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    setConfirmed(false);
    region.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView({ block: 'nearest' });
  }, [review.id, review.revision, review.preview.digest]);
  const current = row.revision === review.revision && row.value.preview?.digest === review.preview.digest;
  return <section ref={region} tabIndex={-1} aria-label="Review website request" className="space-y-3 rounded-lg border border-agency bg-paper p-4 focus-visible:outline-2 focus-visible:outline-agency">
    <div><h5 className="font-medium">{review.preview.title}</h5><p className="mt-1 text-ink-secondary">Review the exact work on this computer before allowing one preparation.</p></div>
    <p>Requested by <strong className="break-words">{row.value.envelope.requester}</strong>. Approval expires {date(row.value.envelope.expiresAt)}.</p>
    <dl className="space-y-3">{review.preview.details.map((detail, index) => <div key={`${index}:${detail.label}`} className="min-w-0"><dt className="font-medium">{detail.label}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-ink-secondary [overflow-wrap:anywhere]">{detail.value || 'None'}</dd></div>)}</dl>
    <p className="text-ink-secondary">Results stay in this workspace. The website receives progress and an outcome reference. This approval does not enable a schedule, send messages or submit bank transactions.</p>
    {!current && <p role="alert" className="text-hold">This request changed. Close this review and open the current plan again.</p>}
    <label className="flex min-h-11 items-start gap-2"><input className="mt-1" type="checkbox" checked={confirmed} disabled={busy || !current || !enabled} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed this plan, its sources and limits, and approve this preparation.</span></label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`${button} border-agency`} disabled={busy || !enabled || !current || !confirmed} onClick={() => decide('approve')}>Approve and prepare</button>
      <button type="button" className={button} disabled={busy || !enabled || !current} onClick={() => decide('reject')}>Decline request</button>
      <button type="button" className={button} disabled={busy} onClick={close}>Close review</button>
    </div>
  </section>;
}

export function WebsiteRequestsCard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<OfficeLinkStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [label, setLabel] = useState('My workspace');
  const [selected, setSelected] = useState<string[]>([]);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [disableConfirmed, setDisableConfirmed] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [cancelReview, setCancelReview] = useState<{ id: string; revision: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const active = useRef(true);
  const operation = useRef(false);
  const readSequence = useRef(0);
  const latest = useRef<Snapshot | null>(null);
  const olderLoaded = useRef(false);
  const linkIdentity = useRef('');
  const reviewOpen = useRef(false);
  reviewOpen.current = review !== null;

  const refresh = useCallback(async (append = false) => {
    const sequence = ++readSequence.current;
    const before = append ? latest.current?.next : null;
    const [result, office] = await Promise.all([
      api(`/api/website-requests${before ? `?before=${before}` : ''}`, undefined, { timeoutMs: 15_000 }) as Promise<Snapshot>,
      api('/api/office-link', undefined, { timeoutMs: 15_000 }) as Promise<OfficeLinkStatus>,
    ]);
    if (!active.current || sequence !== readSequence.current) return;
    const previous = latest.current;
    const catalogChanged = previous && JSON.stringify(previous.status.catalog) !== JSON.stringify(result.status.catalog);
    const nextLinkIdentity = `${office.state}:${office.id ?? ''}`;
    if (catalogChanged || linkIdentity.current !== nextLinkIdentity) setPublishConfirmed(false);
    linkIdentity.current = nextLinkIdentity;
    if (append) olderLoaded.current = true;
    const next = append
      ? { ...result, records: [...new Map([...(previous?.records ?? []), ...result.records].map(row => [row.id, row])).values()] }
      : olderLoaded.current && previous
        ? { ...result, records: [...result.records, ...previous.records.filter(row => !result.records.some(item => item.id === row.id))], next: previous.next }
        : result;
    latest.current = next;
    setSnapshot(next); setLink(office);
    setSelected(ids => ids.filter(id => result.status.catalog.some(descriptor => descriptor.id === id)));
    setReview(current => {
      if (!current) return null;
      const row = result.records.find(item => rowId(item) === current.id);
      return result.status.enabled && !result.status.pending && office.state === 'linked' && row?.revision === current.revision && row.value.preview?.digest === current.preview.digest && !row.value.restored ? current : null;
    });
    setCancelReview(current => current && next.records.some(row => rowId(row) === current.id && row.revision === current.revision) ? current : null);
  }, []);

  useEffect(() => {
    active.current = true;
    const load = () => {
      if (operation.current || reviewOpen.current || document.visibilityState === 'hidden') return;
      void refresh().catch(() => { if (active.current) setError('Website requests could not be refreshed. Your saved work is unchanged.'); });
    };
    const linkChanged = () => {
      reviewOpen.current = false;
      setReview(null); setPublishConfirmed(false);
      load();
    };
    load();
    const timer = window.setInterval(load, 15_000);
    window.addEventListener('realbud-website-link-changed', linkChanged);
    document.addEventListener('visibilitychange', load);
    return () => { active.current = false; ++readSequence.current; window.clearInterval(timer); window.removeEventListener('realbud-website-link-changed', linkChanged); document.removeEventListener('visibilitychange', load); };
  }, [refresh]);

  const perform = async (action: string, work: () => Promise<void>, success: string, reload = true) => {
    if (operation.current) return;
    operation.current = true; ++readSequence.current;
    setBusy(action); setError(''); setNotice('');
    try { await work(); if (active.current) { if (reload) await refresh(); setNotice(success); } }
    catch (cause) {
      if (!active.current) return;
      setReview(null); setPublishConfirmed(false); setCancelReview(null);
      let refreshed = false;
      try { await refresh(); refreshed = true; } catch { /* Preserve the last known rows until a successful refresh. */ }
      if (active.current) setError(`${safeError(cause, 'This action could not be confirmed.')} ${refreshed ? 'Current saved status is shown below. Review it before trying again.' : 'Refresh the saved status before trying again; the earlier action may have completed.'}`);
    } finally { operation.current = false; if (active.current) setBusy(null); }
  };
  const post = (path: string, body: unknown) => api(`/api/website-requests${path}`, { method: 'POST', body: JSON.stringify(body) }, { timeoutMs: 45_000 });
  const manualRefresh = () => { setReview(null); setCancelReview(null); void perform('refresh', async () => {}, 'Saved request status refreshed.'); };
  const openPreview = (row: RequestRow) => {
    setReview(null);
    void perform('preview', async () => {
      const result: RequestRow = await post(`/${encodeURIComponent(rowId(row))}/preview`, { expectedRevision: row.revision });
      if (!result.value.preview || rowId(result) !== rowId(row)) throw new Error('The current plan could not be confirmed.');
      if (active.current) {
        if (latest.current) {
          const next = { ...latest.current, records: latest.current.records.map(item => item.id === result.id ? result : item) };
          latest.current = next; setSnapshot(next);
        }
        setReview({ id: rowId(result), revision: result.revision, preview: result.value.preview });
      }
    }, 'The current plan is ready for review. Opening this preview does not start work.', false);
  };
  const decide = (choice: 'approve' | 'reject') => {
    const current = review;
    if (!current) return;
    void perform('decision', async () => {
      await post(`/${encodeURIComponent(current.id)}/decision`, { expectedRevision: current.revision, previewDigest: current.preview.digest, decision: choice });
      setReview(null);
    }, choice === 'approve' ? 'Your decision was saved. Follow the outcome below.' : 'The request was declined.');
  };

  const status = snapshot?.status;
  const pendingDescriptors = status?.publishedDescriptors ?? status?.grant?.descriptors ?? [];
  const enrolled = !!status?.enabled && !status.pending && !!status.grant;
  const enabled = enrolled && status?.linked && link?.state === 'linked';
  const working = !!busy || !!status?.busy;
  const published = status?.pending ? pendingDescriptors : status?.catalog.filter(descriptor => selected.includes(descriptor.id)) ?? [];
  const activeRows = snapshot?.records.filter(row => !row.value.restored && activePhases.includes(row.value.phase)) ?? [];
  const historyRows = snapshot?.records.filter(row => row.value.restored || !activePhases.includes(row.value.phase)) ?? [];
  const sameGrant = (row: RequestRow) => !!status?.grant && row.value.envelope.grantId === status.grant.grantId && row.value.envelope.generation === status.grant.generation && row.value.envelope.workspaceId === status.workspaceId;

  const requestItem = (row: RequestRow) => {
    const value = row.value;
    const identity = rowId(row);
    const isCurrent = sameGrant(row) && !value.restored;
    const canReview = enabled && isCurrent && !value.run && ['queued', 'delivered', 'interrupted'].includes(value.phase) && Date.parse(value.envelope.expiresAt) > Date.now() && !value.remote.cancellationRequested && !value.cancellationRequested;
    const canCancel = !value.restored && activePhases.includes(value.phase) && !value.cancellationRequested;
    const selectedReview = review?.id === identity ? review : null;
    const confirmingCancel = cancelReview?.id === identity && cancelReview.revision === row.revision;
    return <li key={row.id} className="min-w-0 space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="min-w-0 break-words font-medium">{value.envelope.descriptor.label}</h4><span className="rounded bg-raised px-2 py-1 text-xs">{phaseLabels[value.phase]}</span></div>
      <p className="break-words text-ink-secondary">Requested by {value.envelope.requester} · {date(value.envelope.createdAt)}</p>
      {value.restored ? <p className="text-hold">Restored history only. Previous permissions and approvals cannot start work on this computer.</p> : !isCurrent ? <p className="text-ink-secondary">This request belongs to an earlier workspace permission. It cannot use the current permission.</p> : null}
      {(value.remote.cancellationRequested || value.cancellationRequested) && <p role="status" className="text-hold">Cancellation requested. Preparation already running may still finish. The confirmed outcome will appear here; prepared work stays saved.</p>}
      {value.phase === 'interrupted' && <p className="text-hold">Work was interrupted or its outcome has not been confirmed. Check the saved run before making another decision. No automatic retry is started here.</p>}
      {['completed', 'needs-review', 'partial'].includes(value.phase) && <p className="text-ink-secondary">Open the relevant workspace to review the prepared results. Preparation does not mean anything was sent or submitted.</p>}
      {value.phase === 'failed' && <p className="text-ink-secondary">Review the saved run in this workspace before requesting another attempt.</p>}
      {value.phase === 'stale' && <p className="text-ink-secondary">The approved work changed. Publish the current plan before asking the website to request it again.</p>}
      {value.phase === 'expired' && <p className="text-ink-secondary">The request expired before preparation could start. Ask for a new request if the work is still needed.</p>}
      <details><summary className="min-h-11 cursor-pointer py-2 text-ink-secondary">Request details</summary><dl className="space-y-2 break-words text-xs [overflow-wrap:anywhere]">
        <div><dt className="font-medium">Request reference</dt><dd>{identity}</dd></div>
        <div><dt className="font-medium">Private workspace reference</dt><dd>{value.envelope.workspaceId}</dd></div>
        <div><dt className="font-medium">Expires</dt><dd>{date(value.envelope.expiresAt)}</dd></div>
        {value.run && <div><dt className="font-medium">Local run reference</dt><dd>{value.run.id}</dd></div>}
        {value.runReference && <div><dt className="font-medium">Website outcome reference</dt><dd>{value.runReference}</dd></div>}
        <div><dt className="font-medium">Last confirmed website status</dt><dd>{phaseLabels[value.remote.phase]} · {date(value.remote.updatedAt)}</dd></div>
      </dl></details>
      {value.phase !== value.remote.phase && <p className="text-xs text-ink-muted">The website has not yet confirmed this latest local status.</p>}
      <div className="flex flex-wrap gap-2">
        {canReview && !selectedReview && <button type="button" className={button} disabled={working} onClick={() => openPreview(row)}>Review current plan</button>}
        {canCancel && !confirmingCancel && <button type="button" className={button} disabled={working} onClick={() => { setReview(null); setCancelReview({ id: identity, revision: row.revision }); }}>Cancel request</button>}
      </div>
      {selectedReview && <ExactRequestReview review={selectedReview} row={row} busy={working} enabled={!!canReview} close={() => setReview(null)} decide={decide} />}
      {confirmingCancel && <div className="space-y-2 rounded border border-line p-3"><p>Cancel this request? If preparation already started, it may still finish. RealBud will request a stop where supported and keep the saved outcome. Cancellation does not undo completed work.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working} onClick={() => void perform('cancel', async () => { await post(`/${encodeURIComponent(identity)}/cancel`, { expectedRevision: row.revision }); setCancelReview(null); }, 'Cancellation was saved. Check the confirmed outcome below.')}>Confirm cancellation</button><button type="button" className={button} disabled={working} onClick={() => setCancelReview(null)}>Keep request</button></div></div>}
    </li>;
  };

  return <Card title="Requests from the website" subtitle="Choose which work your website account can request in this private workspace. Each request needs your review here.">
    <div className="space-y-4 text-sm">
      <p className="text-ink-secondary">An account owner can ask this computer to prepare selected work while RealBud is open. They cannot approve it for you or access another person’s workspace.</p>
      {!snapshot ? <p role="status">Loading website request settings…</p> : <>
        <dl className="grid gap-3 rounded-lg bg-raised p-3 sm:grid-cols-3">
          <div className="min-w-0"><dt className="text-xs text-ink-muted">Website account</dt><dd className="break-words font-medium">{link?.state === 'linked' ? link.agencyLabel || 'Linked account' : 'Not linked'}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-ink-muted">Computer</dt><dd className="break-words font-medium">{link?.label || 'This computer'}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-ink-muted">Private workspace</dt><dd className="break-words font-medium">{status?.workspaceLabel || 'Your workspace on this computer'}</dd></div>
        </dl>
        {!status?.linked || link?.state !== 'linked' ? <p className="text-hold">Link this computer to your website account above before enabling requests. Saved request history remains available here.</p> : null}
        {enrolled ? <div className="space-y-3"><p role="status" className="font-medium">{enabled ? 'Website requests are enabled · local review required' : 'Permission saved · website link unavailable'}</p><p className="text-ink-secondary">The website can request these published plans:</p><ul className="list-disc space-y-1 pl-5">{pendingDescriptors.map(descriptor => <li key={descriptor.id} className="break-words">{descriptor.label}</li>)}</ul><p className="text-xs text-ink-muted">To change this list or its public name, disable requests and publish the reviewed selection again.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working} onClick={() => void perform('sync', async () => { await post('/sync', {}); }, 'Website requests and saved outcomes were checked.')}>{busy === 'sync' ? 'Checking…' : 'Check website requests'}</button><button type="button" className={button} disabled={working} onClick={() => setDisableConfirmed(true)}>Disable website requests</button></div></div> : status?.pending ? <div className="space-y-3 rounded border border-line p-3"><p role="status" className="font-medium">Permission setup needs confirmation</p><p>The website reply was not confirmed. Retry the original setup safely, or cancel it before choosing different work.</p><p className="break-words">Public workspace name: <strong>{status.workspaceLabel}</strong></p><ul className="list-disc space-y-1 pl-5">{pendingDescriptors.map(descriptor => <li key={descriptor.id}>{descriptor.label}</li>)}</ul><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working || !status.linked || !pendingDescriptors.length} onClick={() => void perform('enroll', async () => { await post('/enroll', { label: status.workspaceLabel, descriptorIds: pendingDescriptors.map(descriptor => descriptor.id) }); }, 'Website request permission was confirmed.')}>Retry permission setup</button><button type="button" className={button} disabled={working} onClick={() => setDisableConfirmed(true)}>Cancel permission setup</button></div></div> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (working || !publishConfirmed || !status?.linked || !published.length || !label.trim()) return; void perform('enroll', async () => { await post('/enroll', { label: label.trim(), descriptorIds: published.map(descriptor => descriptor.id) }); setPublishConfirmed(false); }, 'The reviewed workspace name and plans were published. Each request still needs your local approval.'); }}>
          <p role="status" className="font-medium">Website requests are disabled</p>
          <label className="block">Workspace name shown on the website<input className="mt-1 block min-h-11 w-full rounded-lg border border-line bg-paper px-3 py-2" maxLength={80} required value={label} disabled={working} autoComplete="off" onChange={event => { setLabel(event.target.value); setPublishConfirmed(false); }} /></label>
          <fieldset disabled={working || !status?.linked} className="space-y-2"><legend className="mb-2 font-medium">Work the website may request</legend>{status?.catalog.length ? status.catalog.map(descriptor => <label key={descriptor.id} className="flex min-h-11 items-start gap-2 rounded border border-line p-3"><input type="checkbox" className="mt-1" checked={selected.includes(descriptor.id)} onChange={event => { setSelected(ids => event.target.checked ? [...ids, descriptor.id] : ids.filter(id => id !== descriptor.id)); setPublishConfirmed(false); }} /><span className="min-w-0 break-words">{descriptor.label}<span className="mt-0.5 block text-xs text-ink-muted">{descriptor.operation === 'morning-review' ? 'Review the locally approved inbox source and prepare priorities.' : 'Prepare the existing approved local plan.'}</span></span></label>) : <p className="text-ink-secondary">No supported approved plans are available yet. Complete your agency and workflow setup, then refresh this list.</p>}</fieldset>
          <p className="text-ink-secondary">The selected plan names and this workspace name will be shared with your website account. Choose names that are appropriate to share. Source details, messages, drafts and connected-app keys stay on this computer.</p>
          <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1" checked={publishConfirmed} disabled={working || !published.length || !label.trim()} onChange={event => setPublishConfirmed(event.target.checked)} /><span>I reviewed these names and allow account owners to request this work for my review here.</span></label>
          <button type="submit" className={button} disabled={working || !status?.linked || !published.length || !label.trim() || !publishConfirmed}>Enable reviewed website requests</button>
        </form>}
        {disableConfirmed && <div className="space-y-3 rounded-lg border border-line p-3"><p>Disable requests for this workspace? New work will be blocked locally even if the website is offline. Preparation already running may still finish; RealBud requests a stop where supported. Saved records and outcomes stay available.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={working} onClick={() => void perform('disable', async () => { await post('/disable', {}); setDisableConfirmed(false); setReview(null); }, 'Requests are disabled for this workspace.')}>Confirm disable</button><button type="button" className={button} disabled={working} onClick={() => setDisableConfirmed(false)}>Keep current setting</button></div></div>}
        <section aria-label="Website request queue" className="space-y-3"><h4 className="font-medium">Requests and work in progress</h4>{activeRows.length ? <ul className="space-y-3">{activeRows.map(requestItem)}</ul> : <p className="text-ink-secondary">No requests are waiting in the loaded history.</p>}</section>
        <section aria-label="Website request history" className="space-y-3"><button type="button" className={button} aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>{showHistory ? 'Hide' : 'Show'} completed and restored history ({historyRows.length})</button>{showHistory && (historyRows.length ? <ul className="space-y-3">{historyRows.map(requestItem)}</ul> : <p className="text-ink-secondary">No completed requests in the loaded history.</p>)}{snapshot.next !== null && <button type="button" className={button} disabled={working} onClick={() => void perform('history', async () => { await refresh(true); }, 'Older request history loaded.', false)}>Load older requests</button>}</section>
      </>}
      {(error || status?.error) && <p role="alert" className="break-words text-red-700">{error || status?.error}</p>}
      {notice && <p role="status" aria-live="polite" className="text-ink-secondary">{notice}</p>}
      <button type="button" className={button} disabled={working} onClick={manualRefresh}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh saved status'}</button>
      <p className="text-xs text-ink-muted">Website requests do not activate a subscription, change provider settings or authorize bank posting. A website connection can be unavailable while local work remains usable.</p>
    </div>
  </Card>;
}
