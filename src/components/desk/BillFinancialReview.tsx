import { useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import type { SourceBillOccurrence, BillFinancialReview as SavedFinancialReview } from '@shared/source-bills';
import { isBillFinancialReviewStale } from '@shared/source-bills';
import type { BillFinancialReviewDraft, BillReviewDraft, BillReviewDraftPage, BillReviewDraftValue } from '@shared/bill-review-drafts';
import { billReviewDrafts } from '@/lib/bill-review-drafts';
import { financialConfirmationKey, financialDimensionLabels, financialDimensions, financialLabels, financialObservedDraft, financialObservedInput, financialReviewRequest, matchesFinancialReceipt, newFinancialDraft, recoveredFinancialDraftReceipt } from '@/lib/bill-financial-review';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink';
billReviewDrafts.configure((path, init) => api(path, init, { timeoutMs: 20_000 }));
const date = (value: number) => new Date(value).toLocaleString();
const closed = (value: BillReviewDraftValue) => value.state === 'accepted' || value.state === 'discarded';
const sourceLabels = { 'external-record': 'External account record', document: 'Supporting document', 'csv-status': 'CSV status only', unknown: 'Unknown source' };

export function BillFinancialSummary({ review, stale = false }: { review?: SavedFinancialReview; stale?: boolean }) {
  return <div className="space-y-2 text-sm">
    <p className="font-medium">{review ? `Human-reviewed claim · ${review.provenance === 'simulated' ? 'Simulated evidence' : 'Actual evidence'}` : 'Financial evidence has not been reviewed.'}</p>
    {review?.provenance === 'simulated' && <p className="text-hold">Simulation only. These states do not establish the live account position.</p>}
    {stale && <p role="alert" className="text-hold">The bill changed after this review. Current financial states are unknown until reviewed again; the earlier claim is retained below.</p>}
    <dl className="grid grid-cols-2 gap-2">{financialDimensions.map(key => <div key={key}><dt className="text-ink-secondary">{financialDimensionLabels[key]}</dt><dd>{!review || stale ? 'Unknown' : financialLabels[key][review[key] as never]}</dd></div>)}</dl>
    {review && <details><summary className="min-h-11 cursor-pointer">{stale ? 'Earlier financial claim and evidence' : 'Reviewed financial evidence'}</summary>
      {stale && <p>{financialDimensions.map(key => `${financialDimensionLabels[key]}: ${financialLabels[key][review[key] as never]}`).join(' · ')}</p>}
      <p>Observed {date(review.observedAt)} · {review.coverage} scope · {sourceLabels[review.sourceKind]}</p>
      <p className="break-words">Account: {review.accountContext || 'Not supplied'} · Location: {review.locator || 'Not supplied'}</p>
      <ul>{review.sourceIds.map(id => <li key={id} className="break-words">{id}</li>)}</ul>
      {review.note && <p className="whitespace-pre-wrap break-words">{review.note}</p>}
      <p className="break-words">{review.reviewReason} · reviewed by {review.reviewedBy} at {date(review.reviewedAt)}</p>
    </details>}
  </div>;
}

export function BillFinancialFields({ value, disabled, onChange }: { value: BillFinancialReviewDraft; disabled: boolean; onChange: (value: BillFinancialReviewDraft) => void }) {
  const change = <K extends keyof BillFinancialReviewDraft>(key: K, next: BillFinancialReviewDraft[K]) => onChange({ ...value, [key]: next });
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">Evidence basis<select className={input} disabled={disabled} value={value.provenance} onChange={event => change('provenance', event.target.value as BillFinancialReviewDraft['provenance'])}><option value="simulated">Simulated evidence</option><option value="actual">Actual evidence I checked</option></select></label>
      <label className="block">Evidence source type<select className={input} disabled={disabled} value={value.sourceKind} onChange={event => change('sourceKind', event.target.value as BillFinancialReviewDraft['sourceKind'])}><option value="unknown">Unknown</option><option value="external-record">External account record</option><option value="document">Supporting document</option><option value="csv-status">CSV status only</option></select></label>
      {financialDimensions.map(key => <label className="block" key={key}>{financialDimensionLabels[key]} state<select className={input} disabled={disabled} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })}>{Object.entries(financialLabels[key]).map(([state, label]) => <option value={state} key={state}>{label}</option>)}</select></label>)}
    </div>
    <p className="text-ink-secondary">Each state needs its own evidence. A received invoice, CSV status or arranged payment does not prove payment, available funds or advance recovery.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">Evidence location<input className={input} disabled={disabled} maxLength={1000} value={value.locator} onChange={event => change('locator', event.target.value)} placeholder="Record, ledger page or document location" /></label>
      <label className="block">Account context<input className={input} disabled={disabled} maxLength={200} value={value.accountContext} onChange={event => change('accountContext', event.target.value)} placeholder="Account and property checked" /></label>
      <label className="block">Observed at (your local time)<input type="datetime-local" step="1" className={input} disabled={disabled} value={financialObservedInput(value.observedAt)} onChange={event => change('observedAt', financialObservedDraft(event.target.value))} /></label>
      <label className="block">Scope checked<select className={input} disabled={disabled} value={value.coverage} onChange={event => change('coverage', event.target.value as BillFinancialReviewDraft['coverage'])}><option value="unknown">Unknown scope</option><option value="partial">Partial scope</option><option value="complete">Complete stated scope</option></select></label>
    </div>
    <label className="block">Evidence references (one per line)<textarea className={input} rows={2} disabled={disabled} maxLength={4000} value={value.sourceIds} onChange={event => change('sourceIds', event.target.value)} placeholder="Receipt, transaction, ledger or document references" /></label>
    <label className="block">Evidence note<textarea className={input} rows={2} disabled={disabled} maxLength={1000} value={value.note} onChange={event => change('note', event.target.value)} placeholder="What was checked, and any limits on the result" /></label>
    <label className="block">Reason for this financial review<input className={input} disabled={disabled} maxLength={1000} value={value.reviewReason} onChange={event => change('reviewReason', event.target.value)} /></label>
  </div>;
}

type BillFinancialReviewProps = {
  bill: SourceBillOccurrence; workspaceId: string; disabled?: boolean; onSaved?: (bill: SourceBillOccurrence) => void | Promise<void>;
};
export function BillFinancialReview(props: BillFinancialReviewProps) {
  return <BillFinancialReviewBody key={`${props.workspaceId}/${props.bill.id}`} {...props} />;
}
function BillFinancialReviewBody({ bill, workspaceId, disabled = false, onSaved }: BillFinancialReviewProps) {
  const [currentBill, setCurrentBill] = useState(bill), [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmation, setConfirmation] = useState<string | null>(null);
  const [latest, setLatest] = useState<SourceBillOccurrence | null>(null), [savedReceipt, setSavedReceipt] = useState<SourceBillOccurrence | null>(null);
  const [, redraw] = useState(0), mounted = useRef(true), operation = useRef(0), pending = useRef(false);
  const local = draftId ? billReviewDrafts.get(workspaceId, draftId) : undefined;
  const value = local?.value, finance = value?.financialReview;
  const confirmed = !!value && confirmation === financialConfirmationKey(value);
  const setConfirmed = (next: boolean) => setConfirmation(next && value ? financialConfirmationKey(value) : null);
  const staleDraft = !!value && (value.billRevision !== currentBill.revision || value.sourceDigest !== currentBill.source.digest);
  const locked = disabled || busy || !!savedReceipt;
  useEffect(() => { mounted.current = true; const unsubscribe = billReviewDrafts.subscribe(() => { if (mounted.current) redraw(count => count + 1); }); return () => { mounted.current = false; operation.current++; unsubscribe(); }; }, []);
  useEffect(() => { if (bill.id === currentBill.id && bill.revision >= currentBill.revision) setCurrentBill(bill); }, [bill]);
  const run = async (work: () => Promise<void>) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true); setError('');
    try { await work(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The review could not be saved. Your entries are kept.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const edit = (next: BillFinancialReviewDraft) => {
    if (!value || !draftId) return;
    billReviewDrafts.edit(draftId, { ...value, financialReview: next }); setConfirmed(false); setNotice('');
  };
  const open = async () => {
    if (!workspaceId) throw new Error('Read the current workspace before opening a financial review.');
    const sequence = ++operation.current;
    const own = billReviewDrafts.list(workspaceId).filter(entry => entry.value.billId === bill.id && entry.value.financialReview && !closed(entry.value));
    let id: string | undefined = own.find(entry => entry.dirty || entry.saving)?.id ?? own[0]?.id;
    if (!id) {
      let cursor: string | null = null;
      const visited = new Set<string>();
      do {
        const page: BillReviewDraftPage = await api(`/api/bill-review-drafts?filter=active&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (page.workspaceId !== workspaceId || page.version !== 1) throw new Error('Financial drafts belong to a different workspace.');
        id = page.items.find(row => row.billId === bill.id && row.hasFinancialReview)?.id;
        cursor = page.nextCursor;
        if (cursor && visited.has(cursor)) throw new Error('Financial draft pages changed. Retry before starting another review.');
        if (cursor) visited.add(cursor);
      } while (!id && cursor);
    }
    if (id) {
      const retained = billReviewDrafts.get(workspaceId, id);
      if (!retained?.dirty && !retained?.saving) {
        const result: { draft: BillReviewDraft } = await api(`/api/bill-review-drafts/${id}`);
        if (result.draft.workspaceId !== workspaceId || result.draft.billId !== bill.id || !result.draft.financialReview || closed(result.draft)) throw new Error('This financial draft no longer matches the open bill.');
        billReviewDrafts.adopt(result.draft);
      }
    } else {
      id = crypto.randomUUID(); billReviewDrafts.edit(id, newFinancialDraft(currentBill, workspaceId), false);
    }
    if (!mounted.current || sequence !== operation.current) return;
    setDraftId(id); setConfirmed(false); setLatest(null); setSavedReceipt(null);
    await billReviewDrafts.flush(workspaceId, id);
    const readback = await api(`/api/bill-occurrences/${bill.id}`);
    if (!mounted.current || sequence !== operation.current) return;
    if (!readback.occurrence || readback.occurrence.id !== bill.id) throw new Error('The current bill is unavailable. Your encrypted draft is kept.');
    setCurrentBill(readback.occurrence);
    const retained = billReviewDrafts.get(workspaceId, id)!;
    const receipt = recoveredFinancialDraftReceipt(retained.value, readback.occurrence);
    setSavedReceipt(receipt);
    setNotice(receipt ? 'This exact financial claim is already saved. Finish its draft record below; no new claim will be submitted.' : 'Draft saved in this workspace. Review the evidence and confirm again before saving the claim.');
  };
  const finishDraft = async (row: SourceBillOccurrence) => {
    if (!draftId) return;
    const entry = billReviewDrafts.get(workspaceId, draftId);
    if (!entry) throw new Error('The financial claim is saved. Keep this view open to finish its draft receipt.');
    // A second panel may have typed while the accepted request was in flight.
    // Its newer wording is still a draft, never the already-reviewed claim.
    if (!recoveredFinancialDraftReceipt(entry.value, row)) {
      setCurrentBill(row); setSavedReceipt(null); setConfirmed(false);
      setNotice('The submitted claim is saved. Newer financial draft entries are kept and need a separate review.');
      if (mounted.current) await onSaved?.(row);
      return;
    }
    setSavedReceipt(row); setCurrentBill(row);
    billReviewDrafts.edit(draftId, { ...entry.value, state: 'accepted' }, false);
    await billReviewDrafts.flush(workspaceId, draftId);
    if (!mounted.current) return;
    setDraftId(null); setSavedReceipt(null); setConfirmed(false); setLatest(null);
    setNotice('Financial claim saved with its evidence and review history.');
    await onSaved?.(row);
  };
  const save = async () => {
    if (!value || !draftId || !finance) return;
    if (savedReceipt) { await finishDraft(savedReceipt); return; }
    const current = billReviewDrafts.get(workspaceId, draftId)?.value;
    if (!current || !confirmed || confirmation !== financialConfirmationKey(current) || staleDraft) throw new Error('Read the current bill and confirm the reviewed evidence before saving. Your draft is kept.');
    const sent = financialReviewRequest(current);
    await billReviewDrafts.flush(workspaceId, draftId);
    const persisted = billReviewDrafts.get(workspaceId, draftId)?.value;
    if (!persisted || confirmation !== financialConfirmationKey(persisted)) { setConfirmed(false); throw new Error('The financial draft changed while saving. Recheck its current entries before confirming.'); }
    let row: SourceBillOccurrence;
    try {
      row = await api(`/api/bill-occurrences/${bill.id}/financial-review`, { method: 'POST', body: JSON.stringify(sent) }, { timeoutMs: 20_000 });
      if (!matchesFinancialReceipt(row, bill.id, sent)) throw new Error('The returned financial review does not match this request.');
    } catch (cause) {
      const result = await api(`/api/bill-occurrences/${bill.id}`).catch(() => null);
      if (matchesFinancialReceipt(result?.occurrence, bill.id, sent)) row = result.occurrence;
      else {
        if (result?.occurrence?.id === bill.id) { setCurrentBill(result.occurrence); setLatest(result.occurrence); }
        setConfirmed(false);
        throw new Error(`Financial review not confirmed. Your encrypted draft is kept. ${cause instanceof Error ? cause.message : 'Check the saved bill before retrying.'}`);
      }
    }
    await finishDraft(row);
  };
  const readCurrent = async () => {
    const result = await api(`/api/bill-occurrences/${bill.id}`);
    if (!result.occurrence || result.occurrence.id !== bill.id) throw new Error('The current bill is unavailable. Your draft is kept.');
    setLatest(result.occurrence); setCurrentBill(result.occurrence); setConfirmed(false);
  };
  const rebind = async () => {
    if (!latest || !value || !draftId) return;
    billReviewDrafts.edit(draftId, { ...value, billRevision: latest.revision, sourceDigest: latest.source.digest }, false);
    await billReviewDrafts.flush(workspaceId, draftId); setLatest(null); setConfirmed(false);
    setNotice('Your entries are kept against the displayed bill revision. Recheck their evidence before confirming.');
  };
  const history = currentBill.history.flatMap(version => version.financialReview ? [version.financialReview] : []).filter((review, index, all) => all.findIndex(other => other.basisBillRevision === review.basisBillRevision && other.reviewedAt === review.reviewedAt) === index && review.basisBillRevision !== currentBill.financialReview?.basisBillRevision);
  return <details className="rounded-lg border border-line p-3" aria-label={`Financial review for ${bill.facts.invoiceNumber || bill.facts.vendor}`}>
    <summary className="min-h-11 cursor-pointer font-medium">Financial review{currentBill.financialReview?.provenance === 'simulated' ? ' · simulated' : ''}{currentBill.financialReview && isBillFinancialReviewStale(currentBill) ? ' · needs another review' : ''}</summary>
    <div className="space-y-3">
      <BillFinancialSummary review={currentBill.financialReview} stale={isBillFinancialReviewStale(currentBill)} />
      {!finance && <button type="button" className={button} disabled={disabled || busy || !workspaceId} onClick={() => void run(open)}>Open financial review draft</button>}
      {finance && value && <form aria-label="Review financial evidence" className="space-y-3 text-sm" onSubmit={event => { event.preventDefault(); void run(save); }}>
        <p className="text-ink-secondary">This saves a human-reviewed claim. It does not make a payment or change the external account.</p>
        <p role="status">{local?.saving ? 'Saving encrypted financial draft…' : local?.dirty ? 'Draft save is unconfirmed. Keep this window open; your entries are retained here.' : 'Financial draft saved in this workspace. Confirmations are never restored from a draft.'}</p>
        {local?.error && <p role="alert" className="text-hold">{local.error}</p>}
        {local?.conflict && <button type="button" className={button} disabled={locked} onClick={() => void run(async () => { const id = crypto.randomUUID(); billReviewDrafts.edit(id, { ...value, state: 'editing' }, false); await billReviewDrafts.flush(workspaceId, id); billReviewDrafts.releaseLocal(workspaceId, draftId!); setDraftId(id); setConfirmed(false); setNotice('Separate encrypted draft saved. Both versions are retained.'); })}>Save a separate financial draft</button>}
        <BillFinancialFields value={finance} disabled={locked} onChange={edit} />
        {(staleDraft || latest) && <div className="rounded border border-line p-3 space-y-2"><p role="alert" className="text-hold">The saved bill changed. Your financial entries are kept; compare the current bill before applying them.</p>
          <button type="button" className={button} disabled={locked} onClick={() => void run(readCurrent)}>Read current bill before retrying</button>
          {latest && <><p>Current revision {latest.revision} · Invoice {latest.facts.invoiceNumber || 'not confirmed'}{latest.facts.invoiceVersion ? ` · version ${latest.facts.invoiceVersion}` : ''} · {latest.facts.vendor} · {latest.facts.amountCents === null ? 'Amount unknown' : `${(latest.facts.amountCents / 100).toFixed(2)} ${latest.facts.currency}`} · due {latest.facts.dueDate || 'unknown'}</p><p className="break-words">Source: {latest.source.message.subject}</p><button type="button" className={button} disabled={locked || !!local?.conflict} onClick={() => void run(rebind)}>I compared this bill; keep my entries for a new review</button></>}
        </div>}
        <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1" checked={confirmed} disabled={locked || staleDraft || !!local?.conflict} onChange={event => setConfirmed(event.target.checked)} />I checked the referenced evidence, its account and scope, and the selected actual or simulated basis for each financial state.</label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={button} disabled={disabled || busy || !!local?.conflict || (!savedReceipt && (!confirmed || staleDraft))}>{savedReceipt ? 'Finish saving financial review record' : 'Save reviewed financial claim'}</button>
          <button type="button" className={button} disabled={locked || !!local?.conflict} onClick={() => void run(async () => { billReviewDrafts.edit(draftId!, { ...value, state: 'saved' }, false); await billReviewDrafts.flush(workspaceId, draftId!); setDraftId(null); setConfirmed(false); setNotice('Financial draft saved for later. Open it here to continue.'); })}>Save financial draft for later</button>
          {local?.dirty && !local.conflict && <button type="button" className={button} disabled={disabled || busy || local.saving} onClick={() => void run(async () => { await billReviewDrafts.flush(workspaceId, draftId!); })}>Retry financial draft save</button>}
        </div>
      </form>}
      {!!history.length && <details><summary className="min-h-11 cursor-pointer">Earlier financial reviews ({history.length})</summary><div className="space-y-3">{history.map(review => <BillFinancialSummary key={`${review.basisBillRevision}:${review.reviewedAt}`} review={review} />)}</div></details>}
      {error && <p role="alert" className="text-hold">{error}</p>}<p role="status">{busy ? 'Waiting for the saved result…' : notice}</p>
    </div>
  </details>;
}
