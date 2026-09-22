import { useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import type { InvoiceReview } from '@shared/accounts-review';
import type { AgencySetupView } from '@shared/agency-setup';
import type { MailThread, MailWorkItem, MailWorkspaceMetadata, MailTaskPage } from '@shared/mail-ingestion';
import type { BillRecurrenceSeries, BillSourceEvidence, SourceBillOccurrence, SourceBillState, SourceBillsWorkspace, SourceBillPage, BillCalendarEntry } from '@shared/source-bills';
import type { SourceBillOccurrenceResult, SourceBillSeriesResult, SourceBillCurrentSourceResult } from '@shared/source-bills-api';
import { appendBillPage, billPageUrl, mergeBillRows } from '@/lib/source-bill-pages';
import { appendMailPage, mailPageUrl, readMailTaskPage, retainSelectedMailItem } from '@/lib/mail-pages';
import { addBillDays, billDateInZone } from '@shared/bill-dates';
import { displayBillDate, draftBillFacts, emptyBillFacts, savedBillFacts, type BillFactsDraft } from '@/lib/source-bill-form';
import type { BillReviewDraft, BillReviewDraftPage, BillReviewDraftValue } from '@shared/bill-review-drafts';
import type { BillProposalHistory } from '@shared/bill-proposals';
import { billReviewDrafts } from '@/lib/bill-review-drafts';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink';
const states: Record<SourceBillState, string> = { received: 'Received', 'in-process': 'In process', hold: 'On hold', cancelled: 'Cancelled' };
const write = (path: string, method: string, body: unknown) => api(path, { method, body: JSON.stringify(body) });
billReviewDrafts.configure((path, init) => api(path, init, { timeoutMs: 20_000 }));
type Proposal = { run: { id: string; status: string; summary?: string }; proposal: InvoiceReview['documents'][number] | null; sourceDigest: string };
type PatternEdit = { original: BillRecurrenceSeries | null; bill: SourceBillOccurrence; intervalMonths: 1 | 3 | 12; anchorDate: string; windowBeforeDays: number; windowAfterDays: number; timeZone: string; active: boolean; reason: string };

export function SourceBillsPanel({ onSaved, initialBillId }: { onSaved?: () => void; initialBillId?: string }) {
  const [snapshot, setSnapshot] = useState<SourceBillsWorkspace | null>(null);
  const [agency, setAgency] = useState<AgencySetupView | null>(null), [mail, setMail] = useState<MailWorkspaceMetadata | null>(null);
  const [mailPage, setMailPage] = useState<MailTaskPage | null>(null), [mailQuery, setMailQuery] = useState(''), [mailLoading, setMailLoading] = useState(false), [selectedMailItem, setSelectedMailItem] = useState<MailWorkItem | null>(null);
  const mailGeneration = useRef(0), mailQueryRef = useRef('');
  mailQueryRef.current = mailQuery.trim();
  const [discard, setDiscard] = useState<{ kind: 'cancel' } | { kind: 'open'; id: string } | null>(null);
  const [error, setError] = useState(''), [dependencyError, setDependencyError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [range, setRange] = useState(() => { const from = billDateInZone(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone); return { from, to: addBillDays(from, 180) }; });
  const [property, setProperty] = useState('');
  const [stale, setStale] = useState(false), [existingSource, setExistingSource] = useState<SourceBillOccurrence | null>(null), [sourceChecked, setSourceChecked] = useState(false);
  const [matchedPatterns, setMatchedPatterns] = useState<BillRecurrenceSeries[]>([]), [matching, setMatching] = useState(false), [matchingError, setMatchingError] = useState(''), [matchRefresh, setMatchRefresh] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false), [editing, setEditing] = useState<SourceBillOccurrence | null>(null);
  const [itemId, setItemId] = useState(''), [thread, setThread] = useState<MailThread | null>(null), [evidence, setEvidence] = useState<BillSourceEvidence | null>(null);
  const [draft, setDraft] = useState<BillFactsDraft>(emptyBillFacts), [billState, setBillState] = useState<SourceBillState>('received');
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [limited, setLimited] = useState(false);
  const [seriesId, setSeriesId] = useState(''), [arrivalDate, setArrivalDate] = useState(''), [pattern, setPattern] = useState<PatternEdit | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null), [proposalPending, setProposalPending] = useState(false);
  const [reviews, setReviews] = useState<BillReviewDraftPage | null>(null), [reviewHistory, setReviewHistory] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null), [reviewState, setReviewState] = useState<BillReviewDraftValue['state']>('editing');
  const [, redrawDraft] = useState(0), [requestHistory, setRequestHistory] = useState<BillProposalHistory | null>(null);
  const [acceptedReceipt, setAcceptedReceipt] = useState<SourceBillOccurrence | null>(null);
  const draftWorkspace = useRef(''), editorGeneration = useRef(0), initializationGeneration = useRef(0), reviewGeneration = useRef(0);
  const sourceSelection = useRef<Pick<BillReviewDraftValue, 'itemId' | 'messageId' | 'sourceDigest'>>({ itemId: null, messageId: null, sourceDigest: null });
  const billBinding = useRef<Pick<BillReviewDraftValue, 'billId' | 'billRevision'>>({ billId: null, billRevision: null });
  const workspaceId = reviews?.workspaceId ?? '';
  const closed = reviewState === 'accepted' || reviewState === 'discarded';
  const fieldsLocked = busy || closed || !!acceptedReceipt;
  const localDraft = workspaceId && draftId ? billReviewDrafts.get(workspaceId, draftId) : undefined;
  const proposalRequest = useRef<{ requestId: string; itemId: string; messageId: string; expectedSourceDigest: string } | null>(null);
  const pending = useRef(false), mounted = useRef(true), generation = useRef(0), matchGeneration = useRef(0), editor = useRef<HTMLFormElement>(null), discardElement = useRef<HTMLDivElement>(null);
  const timeZone = agency?.state.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const properties = agency?.properties ?? [];
  const label = (id: string) => properties.find(property => property.id === id)?.label ?? id;
  const currentDraftValue = (state = reviewState): BillReviewDraftValue => ({
    workspaceId: draftWorkspace.current, state, ...billBinding.current, ...sourceSelection.current,
    fields: { propertyId: draft.propertyId, kind: draft.kind, vendor: draft.vendor, amount: draft.amount, invoiceDate: draft.invoiceDate, dueDate: draft.dueDate, note: draft.note },
    billState, reason, seriesId, arrivalDate, proposalRequest: proposalRequest.current,
  });
  const loadReviews = async (all = reviewHistory, append = false) => {
    const operation = ++reviewGeneration.current, previous = reviews, filter = all ? 'all' : 'active';
    const next: BillReviewDraftPage = await api(`/api/bill-review-drafts?filter=${filter}&limit=10${append && previous?.nextCursor ? `&cursor=${encodeURIComponent(previous.nextCursor)}` : ''}`);
    if (next.version !== 1 || !next.workspaceId || next.filter !== filter || (append && (next.workspaceId !== previous?.workspaceId || next.nextCursor === previous?.nextCursor))) throw new Error('Saved review pages changed. Refresh reviews; your entered fields are kept.');
    if (mounted.current && operation === reviewGeneration.current) { setReviews(append && previous ? { ...next, items: [...previous.items.filter(row => !next.items.some(item => item.id === row.id)), ...next.items] } : next); setReviewHistory(all); }
    return next;
  };
  const persistDraft = async (state = reviewState) => {
    if (!workspaceId || !draftId || draftWorkspace.current !== workspaceId) throw new Error('Read saved reviews in the original workspace before saving this draft. Keep this review open.');
    billReviewDrafts.edit(draftId, currentDraftValue(state), false);
    const result = await billReviewDrafts.flush(workspaceId, draftId);
    if (mounted.current) setReviewState(state);
    return result;
  };
  const closeReview = () => { editorGeneration.current++; if (billReviewDrafts.activeId(workspaceId) === draftId) billReviewDrafts.setActive(workspaceId, null); setEditorOpen(false); setEditing(null); setDraftId(null); setDiscard(null); };
  const checkRequest = async () => {
    const request = proposalRequest.current, operation = editorGeneration.current; if (!request) return;
    const result: BillProposalHistory = await api(`/api/bill-proposals/${request.requestId}`);
    if (result.version !== 1 || result.requestId !== request.requestId || !result.historical || (result.sourceDigest !== null && result.sourceDigest !== request.expectedSourceDigest)) throw new Error('The retained request receipt does not match this source. Your entries are kept.');
    if (!mounted.current || operation !== editorGeneration.current || proposalRequest.current?.requestId !== request.requestId) return;
    setRequestHistory(result); setProposalPending(result.state !== 'run-recorded' || ['running', 'queued'].includes(result.run?.status ?? ''));
    if (result.run && result.sourceDigest) setProposal({ run: result.run, proposal: result.proposal, sourceDigest: result.sourceDigest });
  };
  const resumeDraft = async (id: string, scope = workspaceId) => {
    const operation = ++editorGeneration.current;
    const current = () => mounted.current && operation === editorGeneration.current;
    let retained = billReviewDrafts.get(scope, id);
    if (!retained?.dirty) {
      const result: { draft: BillReviewDraft } = await api(`/api/bill-review-drafts/${id}`);
      if (!current()) return;
      if (result.draft.workspaceId !== scope) throw new Error('This review belongs to another workspace.');
      retained = billReviewDrafts.adopt(result.draft);
    }
    const value = retained.value;
    if (!current()) return;
    draftWorkspace.current = scope;
    setDraftId(id); setReviewState(value.state); billReviewDrafts.setActive(scope, id);
    billBinding.current = { billId: value.billId, billRevision: value.billRevision };
    sourceSelection.current = { itemId: value.itemId, messageId: value.messageId, sourceDigest: value.sourceDigest };
    setDraft({ ...value.fields }); setBillState(value.billState); setReason(value.reason); setSeriesId(value.seriesId); setArrivalDate(value.arrivalDate);
    setAcceptedReceipt(null); setConfirmed(false); setLimited(false); setProposal(null); setRequestHistory(null); proposalRequest.current = value.proposalRequest;
    setProposalPending(!!value.proposalRequest); setEditing(null); setItemId(value.itemId ?? ''); setSelectedMailItem(null); setThread(null); setEvidence(null); setExistingSource(null); setSourceChecked(false); setStale(false); setPattern(null); setEditorOpen(true);
    try {
      if (value.billId) { const result: SourceBillOccurrenceResult = await api(`/api/bill-occurrences/${value.billId}`); if (!current()) return; if (!result.occurrence) throw new Error('The saved bill is unavailable.'); setEditing(result.occurrence); setStale(result.occurrence.revision !== value.billRevision); }
      if (value.itemId) {
        const [source, selected] = await Promise.all([api(`/api/mail-workspace/items/${value.itemId}/source`), api(`/api/mail-workspace/items/${value.itemId}`)]);
        if (!current()) return;
        setThread(source.thread); setSelectedMailItem(selected.item);
        if (value.messageId) {
          const result: BillSourceEvidence = await api(`/api/bill-evidence/${value.itemId}?messageId=${encodeURIComponent(value.messageId)}`);
          if (!current()) return;
          const found: SourceBillOccurrenceResult = await api(`/api/bill-occurrences/by-source/${result.identity}`);
          if (!current()) return;
          setEvidence(result); setExistingSource(found.occurrence?.id === value.billId ? null : found.occurrence);
          setSourceChecked(result.digest === value.sourceDigest);
          if (result.digest !== value.sourceDigest) setNotice('The saved source changed. Your entries and request are kept. Save this review for later and start a new review to use the changed source.');
        }
      }
    } catch (cause) { if (current()) setNotice(`Your draft is restored, but its source must be checked again. ${cause instanceof Error ? cause.message : 'Source unavailable.'}`); }
  };
  const refresh = async (nextProperty = property) => {
    const current = ++generation.current;
    const result: SourceBillsWorkspace = await api(billPageUrl('/api/bill-register', { ...range, propertyId: nextProperty, limit: 20 }));
    if (result.version !== 2 || result.propertyId !== (nextProperty || null)) throw new Error('The bill view changed. Refresh to check its current pages.');
    if (!mounted.current || current !== generation.current) return;
    setSnapshot(result); setProperty(nextProperty);
    if (editing) {
      const currentBill: SourceBillOccurrenceResult = await api(`/api/bill-occurrences/${editing.id}`);
      if (mounted.current && current === generation.current) setStale(currentBill.occurrence?.revision !== editing.revision);
    }
  };
  const loadMore = async (kind: 'occurrences' | 'series' | 'calendar') => {
    if (!snapshot) return;
    const previous = snapshot[kind], cursor = previous.nextCursor, current = generation.current;
    if (!cursor) return;
    const path = kind === 'calendar' ? '/api/bill-register/calendar' : `/api/bill-${kind}`;
    const next = await api(billPageUrl(path, { propertyId: snapshot.propertyId, cursor, limit: 20, ...(kind === 'calendar' ? snapshot.range : {}) }));
    if (!mounted.current || current !== generation.current) return;
    if (kind === 'calendar') {
      if (next.nextCursor === cursor) throw new Error('The calendar page changed. Refresh before loading more.');
      setSnapshot({ ...snapshot, calendar: { ...next, items: mergeBillRows(snapshot.calendar.items, next.items as BillCalendarEntry[]).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) } });
    } else if (kind === 'occurrences') setSnapshot({ ...snapshot, occurrences: appendBillPage(snapshot.occurrences, next as SourceBillPage<SourceBillOccurrence>, cursor) });
    else setSnapshot({ ...snapshot, series: appendBillPage(snapshot.series, next as SourceBillPage<BillRecurrenceSeries>, cursor) });
  };
  const loadMailPage = async (q = mailQueryRef.current, append = false) => {
    const current = ++mailGeneration.current, previous = mailPage;
    setMailLoading(true);
    try {
      const next = readMailTaskPage(await api(mailPageUrl('/api/mail-workspace/items', { group: 'all', q, limit: 20, cursor: append ? previous?.nextCursor : undefined })), { group: 'all', q });
      if (mounted.current && current === mailGeneration.current) setMailPage(append && previous?.nextCursor ? appendMailPage(previous, next, previous.nextCursor) : next);
    } finally { if (mounted.current && current === mailGeneration.current) setMailLoading(false); }
  };
  const dependencies = async () => {
    const [agencyResult, mailResult, pageResult] = await Promise.allSettled([api('/api/agency-setup'), api('/api/mail-workspace'), loadMailPage()]);
    if (!mounted.current) return;
    if (agencyResult.status === 'fulfilled') setAgency(agencyResult.value);
    if (mailResult.status === 'fulfilled' && mailResult.value.version === 2) setMail(mailResult.value);
    setDependencyError(agencyResult.status === 'rejected' || mailResult.status === 'rejected' || pageResult.status === 'rejected' ? 'The current property or saved-mail list could not be refreshed. Previously loaded records and your open bill review are kept.' : '');
  };
  useEffect(() => {
    mounted.current = true;
    // Each lifecycle owns its load, including React's development effect replay.
    // The old lifecycle may finish, but cannot release the newer busy guard.
    const initialization = ++initializationGeneration.current;
    pending.current = true; setBusy(true);
    void (async () => {
      try {
        const [, , page] = await Promise.all([refresh(), dependencies(), loadReviews()]);
        if (!mounted.current || initialization !== initializationGeneration.current) return;
        const active = billReviewDrafts.activeId(page.workspaceId);
        const activeReview = active ? billReviewDrafts.get(page.workspaceId, active) : undefined;
        if (initialBillId && activeReview?.value.billId !== initialBillId) await openBill(initialBillId, page.workspaceId);
        else if (active) await resumeDraft(active, page.workspaceId);
        else if (initialBillId) await openBill(initialBillId, page.workspaceId);
      } catch (cause) { if (mounted.current && initialization === initializationGeneration.current) setError(cause instanceof Error ? cause.message : 'Saved reviews could not be read.'); }
      finally { if (mounted.current && initialization === initializationGeneration.current) { pending.current = false; setBusy(false); } }
    })();
    return () => { mounted.current = false; initializationGeneration.current++; editorGeneration.current++; reviewGeneration.current++; generation.current++; matchGeneration.current++; mailGeneration.current++; };
  }, []);
  useEffect(() => billReviewDrafts.subscribe(() => redrawDraft(value => value + 1)), []);
  useEffect(() => {
    if (!editorOpen || !draftId || !workspaceId || closed || acceptedReceipt || draftWorkspace.current !== workspaceId) return;
    billReviewDrafts.edit(draftId, currentDraftValue());
  }, [editorOpen, draftId, workspaceId, draft, billState, reason, seriesId, arrivalDate, itemId, evidence, reviewState, proposalPending, acceptedReceipt]);
  useEffect(() => { if (editorOpen) { editor.current?.focus({ preventScroll: true }); editor.current?.scrollIntoView({ block: 'nearest' }); } }, [editorOpen]);
  useEffect(() => { if (discard) { discardElement.current?.focus({ preventScroll: true }); discardElement.current?.scrollIntoView({ block: 'nearest' }); } }, [discard]);
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The saved result could not be confirmed. Refresh the bill before trying again.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const resetSourceReview = () => {
    setConfirmed(false); setLimited(false); setProposal(null); setRequestHistory(null); setProposalPending(false); proposalRequest.current = null;
  };
  const loadMessage = async (sourceItemId: string, messageId: string, reviewingId = editing?.id) => {
    const operation = editorGeneration.current;
    if (proposalRequest.current) throw new Error('This review keeps the source attached to its request. Save it for later and start a new review to select another source.');
    if (!messageId) { sourceSelection.current = { itemId: sourceItemId || null, messageId: null, sourceDigest: null }; setEvidence(null); setExistingSource(null); setSourceChecked(false); resetSourceReview(); return; }
    // Commit a new source only after both evidence and duplicate lookup succeed.
    // A failed read must not erase a review or its source-bound request identity.
    const result: BillSourceEvidence = await api(`/api/bill-evidence/${sourceItemId}?messageId=${encodeURIComponent(messageId)}`);
    if (!mounted.current || operation !== editorGeneration.current) return;
    const found: SourceBillOccurrenceResult = await api(`/api/bill-occurrences/by-source/${result.identity}`);
    if (!mounted.current || operation !== editorGeneration.current) return;
    if (!evidence || evidence.identity !== result.identity || evidence.digest !== result.digest) resetSourceReview();
    sourceSelection.current = { itemId: sourceItemId, messageId, sourceDigest: result.digest };
    setEvidence(result); setExistingSource(found.occurrence?.id === reviewingId ? null : found.occurrence); setSourceChecked(true);
  };
  const loadThread = async (id: string) => {
    const operation = editorGeneration.current;
    if (proposalRequest.current) throw new Error('This review keeps the source attached to its request. Save it for later and start a new review to select another source.');
    if (!id) { sourceSelection.current = { itemId: null, messageId: null, sourceDigest: null }; setItemId(''); setSelectedMailItem(null); setThread(null); setEvidence(null); setExistingSource(null); setSourceChecked(false); resetSourceReview(); return; }
    const [result, selected]: [{ thread: MailThread }, { item: MailWorkItem }] = await Promise.all([api(`/api/mail-workspace/items/${id}/source`), api(`/api/mail-workspace/items/${id}`)]);
    if (!mounted.current || operation !== editorGeneration.current) return;
    if (!selected.item || selected.item.id !== id || selected.item.threadId !== result.thread.id) throw new Error('The saved conversation changed. Refresh its source before continuing.');
    sourceSelection.current = { itemId: id, messageId: null, sourceDigest: null };
    setItemId(id); setSelectedMailItem(selected.item); setThread(result.thread); setEvidence(null); setExistingSource(null); setSourceChecked(false); resetSourceReview();
  };
  const openBill = async (requested: SourceBillOccurrence | string | null, scope = workspaceId) => {
    const operation = ++editorGeneration.current;
    if (!scope) throw new Error('Read saved reviews before starting a bill review.');
    const response: SourceBillOccurrenceResult | null = requested ? await api(`/api/bill-occurrences/${typeof requested === 'string' ? requested : requested.id}`) : null;
    if (!mounted.current || operation !== editorGeneration.current) return;
    const bill = response?.occurrence ?? null;
    if (requested && !bill) throw new Error('That saved bill is unavailable. Refresh the list.');
    const id = crypto.randomUUID(); draftWorkspace.current = scope;
    billReviewDrafts.setActive(scope, id); setDraftId(id); setReviewState('editing');
    sourceSelection.current = { itemId: null, messageId: null, sourceDigest: null };
    billBinding.current = { billId: bill?.id ?? null, billRevision: bill?.revision ?? null };
    setDiscard(null); setSelectedMailItem(null); setStale(false); setExistingSource(null); setSourceChecked(false);
    setEditing(bill); setEditorOpen(true); setPattern(null); setDraft(bill ? draftBillFacts(bill.facts) : emptyBillFacts());
    setBillState(bill?.state ?? 'received'); setReason(''); setConfirmed(false); setLimited(false);
    setAcceptedReceipt(null); setProposal(null); setRequestHistory(null); setProposalPending(false); proposalRequest.current = null;
    setSeriesId(bill?.seriesId ?? ''); setArrivalDate(bill?.expectedArrivalDate ?? ''); setItemId(''); setThread(null); setEvidence(null);
    if (bill) {
      try {
        const current: SourceBillCurrentSourceResult = await api(`/api/bill-occurrences/${bill.id}/source`);
        if (!mounted.current || operation !== editorGeneration.current) return;
        if (current.accountId !== bill.source.accountId || current.thread.id !== bill.source.threadId) throw new Error('The current source does not match this saved bill.');
        const selected: { item: MailWorkItem } = await api(`/api/mail-workspace/items/${current.itemId}`);
        if (!mounted.current || operation !== editorGeneration.current) return;
        setItemId(current.itemId); setSelectedMailItem(selected.item); setThread(current.thread);
        await loadMessage(current.itemId, bill.source.message.id, bill.id);
      } catch {
        if (mounted.current && operation === editorGeneration.current) setNotice('The current saved conversation is unavailable. Previous evidence remains in bill history. Choose an available source before making a correction.');
      }
    }
  };
  const draftDirty = JSON.stringify(draft) !== JSON.stringify(editing ? draftBillFacts(editing.facts) : emptyBillFacts()) || !!reason || confirmed || limited ||
    billState !== (editing?.state ?? 'received') || seriesId !== (editing?.seriesId ?? '') || arrivalDate !== (editing?.expectedArrivalDate ?? '');
  const leaveReview = (intent: { kind: 'cancel' } | { kind: 'open'; id: string }) => {
    if (closed) { closeReview(); return; }
    if (draftDirty || proposalRequest.current) { setDiscard(intent); return; }
    void run(async () => { await persistDraft('discarded'); closeReview(); if (intent.kind === 'open') await openBill(intent.id); await loadReviews(); });
  };
  const acceptBill = async () => {
    if (closed || !evidence || !sourceChecked) throw new Error('Choose and review the current saved source message.');
    let received = acceptedReceipt;
    if (!received) {
      await persistDraft();
      const facts = savedBillFacts(draft);
      const body = { itemId, messageId: evidence.message.id, expectedSourceDigest: evidence.digest, sourceReviewed: confirmed, limitedSourceAcknowledged: limited, facts, reviewReason: reason, seriesId: seriesId || null, expectedArrivalDate: arrivalDate || null,
        ...(editing ? { expectedRevision: billBinding.current.billRevision, state: billState } : {}) };
      try { received = await write(editing ? `/api/bill-occurrences/${editing.id}` : '/api/bill-occurrences', editing ? 'PUT' : 'POST', body); }
      catch (cause) {
        // A saved bill may outlive a lost response. Compare authoritative
        // readback before offering another mutation; never throw notes away.
        let found: SourceBillOccurrence | null = null;
        try { found = (await api(`/api/bill-occurrences/by-source/${evidence.identity}`)).occurrence; } catch { /* Keep the open encrypted draft. */ }
        const matches = found && found.source.digest === evidence.digest && Object.entries(facts).every(([key, value]) => found!.facts[key as keyof typeof facts] === value) && found.reviewReason === reason.trim() && found.seriesId === (seriesId || null) && found.expectedArrivalDate === (arrivalDate || null) && found.state === (editing ? billState : 'received') && (!editing || (found.id === editing.id && found.revision === (billBinding.current.billRevision ?? 0) + 1));
        if (!matches) { if (editing && (cause as { status?: number })?.status === 409) setStale(true); if (found && !editing) setExistingSource(found); throw cause; }
        received = found;
      }
      if (!received?.id) throw new Error('The saved bill receipt is unavailable. Your draft is kept; check the bill records before retrying.');
      setAcceptedReceipt(received);
    }
    billBinding.current = { billId: received.id, billRevision: received.revision };
    await persistDraft('accepted');
    closeReview(); await Promise.all([refresh(), loadReviews()]); setNotice('The reviewed bill, source evidence and review record were saved.'); onSaved?.();
  };
  useEffect(() => {
    if (!editorOpen) return;
    const timer = setTimeout(() => { void loadMailPage(mailQuery.trim()).catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Saved conversations could not be searched. Your bill draft is kept.'); }); }, 250);
    return () => clearTimeout(timer);
  }, [mailQuery, editorOpen]);
  const editPattern = (bill: SourceBillOccurrence, original: BillRecurrenceSeries | null = null) => setPattern({
    original, bill, intervalMonths: original?.intervalMonths ?? 1, anchorDate: original?.anchorDate ?? billDateInZone(bill.source.message.at, timeZone),
    windowBeforeDays: original?.windowBeforeDays ?? 3, windowAfterDays: original?.windowAfterDays ?? 3,
    timeZone: original?.timeZone ?? timeZone, active: original?.active ?? true, reason: '',
  });
  const openPattern = async (seriesId: string) => {
    const result: SourceBillSeriesResult = await api(`/api/bill-series/${seriesId}`);
    if (mounted.current) editPattern(result.occurrence, result.series);
  };
  const openPatternForBill = async (billId: string) => {
    const result: SourceBillOccurrenceResult = await api(`/api/bill-occurrences/${billId}`);
    if (!result.occurrence) throw new Error('That saved bill is unavailable. Refresh the list.');
    if (mounted.current) editPattern(result.occurrence, result.originSeries);
  };
  useEffect(() => {
    const current = ++matchGeneration.current;
    setMatchedPatterns([]); setMatchingError('');
    if (!editorOpen || !evidence || !draft.propertyId || !draft.kind.trim() || !draft.vendor.trim()) { setMatching(false); return; }
    setMatching(true);
    const timer = window.setTimeout(() => {
      void api(billPageUrl('/api/bill-series/matching', { accountId: evidence.accountId, propertyId: draft.propertyId, kind: draft.kind.trim(), vendor: draft.vendor.trim(), includeSeriesId: editing?.seriesId })).then(result => {
        if (mounted.current && current === matchGeneration.current) setMatchedPatterns(result.series);
      }).catch(() => {
        if (mounted.current && current === matchGeneration.current) setMatchingError('Matching arrival patterns could not be checked. Change a field or refresh the source before saving.');
      }).finally(() => { if (mounted.current && current === matchGeneration.current) setMatching(false); });
    }, 200);
    return () => { window.clearTimeout(timer); matchGeneration.current++; };
  }, [editorOpen, evidence?.accountId, draft.propertyId, draft.kind, draft.vendor, editing?.seriesId, matchRefresh]);
  const records = snapshot?.occurrences.items ?? [];
  const calendar = snapshot?.calendar.items ?? [];
  const needsLimited = Boolean(evidence?.message.bodyTruncated || evidence?.message.attachments.length);
  return <section aria-label="Source-linked bills and calendar" className="mt-4 border-t border-line pt-4 space-y-4" aria-busy={busy}>
    <div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-medium">Received bills and expected arrivals</h3><p className="mt-1 text-sm text-ink-secondary">Review facts from saved Gmail messages. Confirm recurring arrival patterns separately; an expected arrival is not an invoice or payment.</p></div><button className={button} disabled={busy} onClick={() => void run(async () => { await Promise.all([refresh(), dependencies()]); setNotice('Saved bills and available sources refreshed.'); })}>Refresh bills and sources</button></div>
    <div className="flex flex-wrap gap-3 items-end"><label className="block text-sm">Property filter<select aria-label="Property filter" className={`${input} mt-1`} value={property} disabled={busy || editorOpen || !!pattern} onChange={e => void run(() => refresh(e.target.value))}><option value="">All available properties</option>{[...new Set([...properties.map(p => p.id), ...(property ? [property] : []), ...(snapshot?.occurrences.items.map(b => b.facts.propertyId) ?? [])])].map(id => <option value={id} key={id}>{label(id)}</option>)}</select></label><button className={button} disabled={busy || editorOpen || !!pattern || !snapshot || !mail || !agency} onClick={() => void run(() => openBill(null))}>Review a bill from saved mail</button><button className={button} disabled={busy || editorOpen || !!pattern || !agency?.workflows.find(w => w.id === 'bills-calendar')?.readyForRun} onClick={() => void run(async () => { await api('/api/bill-scan', { method: 'POST', body: '{}' }, { timeoutMs: 270_000 }); await dependencies(); setNotice('The reviewed bill mail scope was collected. Select a saved message to review its facts.'); })}>Check inbox for bills</button></div><p className="text-sm text-ink-secondary">This checks the Gmail account, date range and message limit reviewed in Agency setup. It saves available conversations for bill review; attachment contents need separate checking.</p>
    {mail?.latestScan && <details className="rounded border border-line p-3 text-sm"><summary className="min-h-11 cursor-pointer">Latest mail collection: {mail.latestScan.status} · {mail.latestScan.threadCount} conversations</summary><p className="break-words">Account {mail.latestScan.accountId} · {new Date(mail.latestScan.startedAt).toLocaleString()}</p><p className="text-ink-secondary">A saved collection is not proof that all bills or attachments were reviewed.</p>{mail.latestScan.gaps.length > 0 && <ul className="list-disc pl-5">{mail.latestScan.gaps.map((gap, index) => <li key={index} className="break-words text-hold">{gap}</li>)}</ul>}</details>}
    {dependencyError && <p role="alert" className="text-sm text-hold">{dependencyError}</p>}
    <details className="rounded-lg border border-line p-3" open={!editorOpen && (!!reviews?.items.length || billReviewDrafts.list(workspaceId).some(row => row.dirty))}>
      <summary className="min-h-11 cursor-pointer font-medium">Saved bill reviews{reviews ? ` (${reviews.items.length} of ${reviews.total})` : ''}</summary>
      <p className="text-sm text-ink-secondary">Drafts are encrypted in this workspace. Reopening a review requires checking its source again; saving a draft does not accept a bill.</p>
      <div className="flex flex-wrap gap-2 my-2"><button className={button} disabled={busy} onClick={() => void run(async () => { await loadReviews(); })}>Refresh saved reviews</button><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reviewHistory} disabled={busy} onChange={event => { const all = event.target.checked; setReviewHistory(all); void run(async () => { try { await loadReviews(all); } catch (cause) { if (mounted.current) setReviewHistory(!all); throw cause; } }); }} />Include closed reviews</label></div>
      {!editorOpen && billReviewDrafts.list(workspaceId).filter(row => row.dirty && !reviews?.items.some(saved => saved.id === row.id)).map(row => <p key={row.id} className="text-sm text-hold">Unconfirmed save · {row.value.fields.vendor || 'Bill review'} <button className={button} disabled={busy} onClick={() => void run(() => resumeDraft(row.id))}>Recover local entries</button></p>)}
      <ul className="space-y-2">{reviews?.items.map(row => <li className="rounded border border-line p-2 text-sm" data-review-id={row.id} key={row.id}><p className="break-words">{row.vendor || 'Bill review'}{row.kind ? ` · ${row.kind}` : ''} · {row.state === 'editing' ? 'Draft' : row.state === 'saved' ? 'Saved for later' : row.state === 'accepted' ? 'Accepted' : 'Discarded'} · {new Date(row.updatedAt).toLocaleString()}</p><button className={button} disabled={busy || editorOpen || !!pattern} onClick={() => void run(() => resumeDraft(row.id))}>{['accepted', 'discarded'].includes(row.state) ? 'View saved review' : 'Continue saved review'}</button></li>)}</ul>
      {reviews?.nextCursor && <button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => { await loadReviews(reviewHistory, true); })}>Load more saved reviews</button>}
      {reviews && !reviews.items.length && <p className="text-sm text-ink-secondary">No saved reviews in this list.</p>}
    </details>
    {discard && <div ref={discardElement} tabIndex={-1} role="alertdialog" aria-label="Discard unsaved bill review" className="rounded-lg border border-hold p-3 space-y-2"><p className="text-sm">Keep this review for later, or close it as discarded. Either choice keeps the encrypted review record and any proposal request; it does not cancel running work.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => { const intent = discard; await persistDraft('discarded'); closeReview(); if (intent.kind === 'open') await openBill(intent.id); await loadReviews(); })}>Discard unsaved bill review</button><button className={button} disabled={busy} onClick={() => void run(async () => { const intent = discard; await persistDraft('saved'); closeReview(); if (intent.kind === 'open') await openBill(intent.id); await loadReviews(); setNotice('Review saved for later. Source confirmations must be checked again when reopened.'); })}>Save review and close</button><button className={button} disabled={busy} onClick={() => { setDiscard(null); editor.current?.focus({ preventScroll: true }); editor.current?.scrollIntoView({ block: 'nearest' }); }}>Keep editing this bill</button></div></div>}
    {editorOpen && <form ref={editor} tabIndex={-1} aria-label="Review source bill" className="rounded-lg border border-agency p-3 space-y-3" onSubmit={e => { e.preventDefault(); void run(acceptBill); }}>
      <h4 className="font-medium">{editing ? 'Correct a saved bill' : 'Review a received bill'}</h4>
      <div className="rounded border border-line p-3 space-y-2 text-sm" aria-label="Bill draft save status">
        <p role="status">{closed ? `Closed review history · ${reviewState}. Its saved fields cannot be changed.` : localDraft?.saving ? 'Saving encrypted review draft…' : localDraft?.dirty ? 'Changes are kept in this window; encrypted save is not confirmed yet.' : localDraft?.revision ? 'Draft saved in this workspace.' : 'Starting encrypted review draft…'}</p>
        {localDraft?.error && <p role="alert" className="text-hold">{localDraft.error}</p>}
        {localDraft?.dirty && !localDraft.conflict && <button type="button" className={button} disabled={busy || localDraft.saving} onClick={() => void run(async () => { if (acceptedReceipt) await acceptBill(); else await persistDraft(); })}>Retry draft save</button>}
        {localDraft?.conflict && <><p>Your current entries remain visible. A separate copy retains the same proposal request and does not run Bud again.</p><button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
          if (!draftId) return;
          const oldId = draftId, newId = crypto.randomUUID();
          billReviewDrafts.edit(newId, currentDraftValue('editing'), false);
          await billReviewDrafts.flush(workspaceId, newId);
          billReviewDrafts.releaseLocal(workspaceId, oldId); billReviewDrafts.setActive(workspaceId, newId);
          setDraftId(newId); setReviewState('editing'); await loadReviews(); setNotice('Your entries were saved as a separate review. The other saved version was preserved.');
        })}>Save my entries as a separate review</button>{localDraft.remote && <details><summary className="min-h-11 cursor-pointer">Other window’s saved entries</summary><p className="whitespace-pre-wrap break-words">{localDraft.remote.fields.note || 'No bill note.'}</p><p className="whitespace-pre-wrap break-words">{localDraft.remote.reason || 'No review reason.'}</p></details>}</>}
        {acceptedReceipt && <p className="text-hold">The bill is recorded. Finish saving this review record to close it; this will not submit the bill again.</p>}
      </div>
      <p className="text-sm text-ink-secondary">One bill per saved message in this workflow. Enter only facts you have checked. Unknown dates and amounts can stay blank. This records an AUD bill; it does not mark payment confirmed.</p>
      <div role="group" aria-label="Saved mail source picker" className="rounded-lg border border-line p-3 space-y-2"><label className="block text-sm">Find a saved conversation<input aria-label="Find a saved conversation" className={`${input} mt-1`} maxLength={200} value={mailQuery} onChange={event => setMailQuery(event.target.value)} placeholder="Subject, reviewer, note or next action" /></label><p role="status" className="text-sm text-ink-secondary">{mailLoading ? 'Searching retained conversations…' : mailPage ? `Showing ${mailPage.items.length} of ${mailPage.total} conversations${mailPage.q ? ` matching “${mailPage.q}”` : ''}. Search checks all saved conversations.` : 'No conversation page is loaded.'}</p>
      <label className="block text-sm">Saved conversation<select aria-label="Saved conversation" className={`${input} mt-1`} disabled={fieldsLocked || !!proposalRequest.current} value={itemId} onChange={e => void run(() => loadThread(e.target.value))}><option value="">Choose a saved conversation…</option>{itemId && !selectedMailItem && !mailPage?.items.some(item => item.id === itemId) && <option value={itemId}>Current saved bill conversation</option>}{retainSelectedMailItem(mailPage?.items ?? [], selectedMailItem).map(item => <option value={item.id} key={item.id}>{item.subject || 'Untitled conversation'}{item.id === itemId && !mailPage?.items.some(row => row.id === item.id) ? ' · selected source outside this page' : ''}</option>)}</select></label>
      {mailPage?.nextCursor && <button type="button" className={button} disabled={busy || mailLoading || mailPage.q !== mailQuery.trim()} onClick={() => void run(() => loadMailPage(mailPage.q, true))}>Load more saved conversations</button>}
      {!mailPage?.items.length && !mailLoading && <p className="text-sm text-hold">{mailPage?.q ? 'No retained conversations match this search. Your selected source is kept.' : 'No saved mail is available in this page. Close this review, then check the reviewed inbox scope above.'}</p>}</div>
      {proposalRequest.current && <p role="status" className="text-sm text-hold">This review keeps the source attached to its request. You can continue manual review or save it for later. To select another source, save and close this review first.</p>}
      {thread && <label className="block text-sm">Source message<select aria-label="Source message" className={`${input} mt-1`} disabled={fieldsLocked || !!proposalRequest.current} value={evidence?.message.id ?? ''} onChange={e => void run(() => loadMessage(itemId, e.target.value))}><option value="">Choose the message containing this bill…</option>{thread.messages.map(message => <option value={message.id} key={message.id}>{new Date(message.at).toLocaleString()} · {message.subject || 'Untitled message'}</option>)}</select></label>}
      {evidence && <aside aria-label="Bill source evidence" className="rounded border border-line bg-paper p-3 space-y-2 text-sm"><p className="font-medium break-words">{evidence.message.subject || 'Untitled message'}</p><p className="break-words">From {evidence.message.from} · received {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(evidence.message.at)} ({timeZone})</p><p className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{evidence.message.body || 'No saved message body.'}</p>{needsLimited && <p className="text-hold">{evidence.message.bodyTruncated ? 'The saved message is truncated. ' : ''}Attachment contents have not been read. Verify missing invoice facts before accepting.</p>}{evidence.message.attachments.length > 0 && <ul className="list-disc pl-5">{evidence.message.attachments.map(a => <li key={a.id} className="break-words">{a.name || 'Unnamed attachment'} · metadata only</li>)}</ul>}<details><summary className="min-h-11 cursor-pointer">Source identifiers</summary><p className="break-all text-xs">Account {evidence.accountId} · message {evidence.message.id} · receipt {evidence.receiptId} · digest {evidence.digest}</p></details></aside>}
      {(evidence || proposalRequest.current) && <div className="rounded border border-line p-3 space-y-2 text-sm"><p>Bud can prepare suggested fields from this saved message. Check the source, confirm missing attachment facts and accept the bill yourself.</p>
        {proposalRequest.current ? <button type="button" className={button} disabled={busy} onClick={() => void run(checkRequest)}>Check the saved proposal request</button> : <button type="button" className={button} disabled={fieldsLocked || !evidence || !sourceChecked || !!localDraft?.conflict || !agency?.workflows.find(w => w.id === 'bills-calendar')?.readyForRun} onClick={() => void run(async () => {
          if (!evidence) return;
          proposalRequest.current = { requestId: crypto.randomUUID(), itemId, messageId: evidence.message.id, expectedSourceDigest: evidence.digest };
          setProposalPending(true);
          await persistDraft();
          const request = proposalRequest.current;
          const result: Proposal = await api('/api/bill-proposals', { method: 'POST', body: JSON.stringify(request) }, { timeoutMs: 270_000 });
          if (result.sourceDigest !== request.expectedSourceDigest) throw new Error('The proposal source changed. Your entries and request are kept.');
          if (mounted.current && proposalRequest.current?.requestId === request.requestId) { setProposal(result); setProposalPending(['queued', 'running'].includes(result.run.status)); }
        })}>Ask Bud to propose fields</button>}
        {proposalRequest.current && <p role="status">The request identifier is kept. Checking reads its saved receipt and does not start another preparation. {proposalPending ? 'Its outcome still needs checking; manual source review remains available.' : 'This historical result does not confirm current source facts.'}</p>}
        {requestHistory && requestHistory.state !== 'run-recorded' && <p className="text-hold">{requestHistory.state === 'intent-recorded' ? 'The request was recorded, but no worker result is recorded.' : 'No saved request receipt is available yet.'} This does not prove that no work started. You can review the source manually or save for later.</p>}
        {proposal && <aside aria-label="Bill field proposal" className="space-y-2"><p className="font-medium">Preparation result · {proposal.run.status}</p>{proposal.proposal ? <><p className="break-words">{proposal.proposal.reason}</p><p>Recommendation: {proposal.proposal.decision}. This does not accept the bill.</p><dl className="grid gap-1 sm:grid-cols-2">{Object.entries(proposal.proposal.proposedEntry).map(([key, value]) => <div key={key} className="break-words"><dt className="text-ink-secondary">{{ supplierId: 'Supplier reference', invoiceId: 'Invoice reference', propertyId: 'Property reference', amount: 'Amount', currency: 'Currency', dueDate: 'Due date', costType: 'Bill kind' }[key] || key}</dt><dd>{value ?? 'Not established'}</dd></div>)}</dl><p className="text-ink-secondary">Copy only fields you confirm against the source into the review below. A supplier reference is not necessarily the vendor name. Invoice dates and attachment contents may be missing.</p></> : <p>No field proposal is available. Manual source review remains available.</p>}<details><summary className="min-h-11 cursor-pointer">Proposal receipt</summary><p className="break-all">Run {proposal.run.id} · source {proposal.sourceDigest}</p></details></aside>}
      </div>}
      {existingSource && <p role="alert" className="text-sm text-hold">This message already has a saved bill. <button type="button" className={button} disabled={fieldsLocked} onClick={() => leaveReview({ kind: 'open', id: existingSource.id })}>Open its saved review</button></p>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Bill property<select aria-label="Bill property" className={`${input} mt-1`} value={draft.propertyId} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, propertyId: e.target.value })}><option value="">Choose a property…</option>{properties.map(p => <option value={p.id} key={p.id}>{p.label}</option>)}</select></label><label className="block text-sm">Bill kind<input className={`${input} mt-1`} maxLength={80} value={draft.kind} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, kind: e.target.value })} placeholder="Water, council or levy" /></label><label className="block text-sm">Vendor<input className={`${input} mt-1`} maxLength={160} value={draft.vendor} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, vendor: e.target.value })} /></label><label className="block text-sm">Amount (AUD)<input className={`${input} mt-1`} inputMode="decimal" value={draft.amount} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, amount: e.target.value })} placeholder="Unknown — leave blank" /></label><label className="block text-sm">Invoice date, if confirmed<input type="date" className={`${input} mt-1`} value={draft.invoiceDate} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, invoiceDate: e.target.value })} /></label><label className="block text-sm">Actual due date, if confirmed<input type="date" className={`${input} mt-1`} value={draft.dueDate} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} /></label></div>
      {editing && <label className="block text-sm">Bill review status<select aria-label="Bill review status" className={`${input} mt-1`} value={billState} disabled={fieldsLocked} onChange={e => setBillState(e.target.value as SourceBillState)}>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {(matchedPatterns.length > 0 || seriesId) && <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Match an approved arrival pattern<select aria-label="Match an approved arrival pattern" className={`${input} mt-1`} value={seriesId} disabled={fieldsLocked} onChange={e => { setSeriesId(e.target.value); setArrivalDate(''); }}><option value="">No pattern link</option>{seriesId && !matchedPatterns.some(series => series.id === seriesId) && <option value={seriesId} disabled>Existing pattern · check matching facts</option>}{matchedPatterns.map(series => <option key={series.id} value={series.id}>{series.kind} · {series.vendor}{series.active ? '' : ' · paused (existing link)'}</option>)}</select></label>{seriesId && <label className="block text-sm">Which expected arrival date?<input type="date" className={`${input} mt-1`} value={arrivalDate} disabled={fieldsLocked} onChange={e => setArrivalDate(e.target.value)} /></label>}</div>}
      <label className="block text-sm">Bill note<textarea aria-label="Bill note" className={`${input} mt-1`} maxLength={1000} value={draft.note} disabled={fieldsLocked} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label>
      <label className="block text-sm">Reason for this bill review<input className={`${input} mt-1`} maxLength={1000} value={reason} disabled={fieldsLocked} onChange={e => setReason(e.target.value)} placeholder="How were the property, currency and dates confirmed?" /></label>
      <label className="flex min-h-11 gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={fieldsLocked || !evidence} onChange={e => setConfirmed(e.target.checked)} />I reviewed this source and confirmed the entered property, AUD amount and dates.</label>
      {needsLimited && <label className="flex min-h-11 gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={limited} disabled={fieldsLocked} onChange={e => setLimited(e.target.checked)} />I understand attachment contents were not read and any truncated text needs separate checking.</label>}
      {matching && <p role="status" className="text-sm text-ink-secondary">Checking approved arrival patterns…</p>}{matchingError && <div role="alert" className="text-sm text-hold"><p>{matchingError}</p><button type="button" className={button} disabled={fieldsLocked} onClick={() => setMatchRefresh(value => value + 1)}>Recheck arrival patterns</button></div>}{evidence && !sourceChecked && <button type="button" className={button} disabled={fieldsLocked} onClick={() => void run(() => loadMessage(itemId, evidence.message.id))}>Recheck saved source</button>}
      {stale && <p role="alert" className="text-sm text-hold">This bill changed elsewhere. Your draft is kept. Reload the saved bill before applying a correction.</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || closed || !!localDraft?.conflict || matching || !!matchingError || (!!seriesId && !matchedPatterns.some(series => series.id === seriesId)) || !sourceChecked || !evidence || !!existingSource || stale || !confirmed || (needsLimited && !limited) || !properties.some(p => p.id === draft.propertyId) || !draft.kind.trim() || !draft.vendor.trim() || !reason.trim()}>{acceptedReceipt ? 'Finish saving review record' : editing ? 'Save bill correction' : 'Accept reviewed bill'}</button>{stale && editing && <button type="button" className={button} disabled={fieldsLocked || !!proposalRequest.current} onClick={() => leaveReview({ kind: 'open', id: editing.id })}>Reload saved bill and discard edits</button>}<button type="button" className={button} disabled={busy || !!acceptedReceipt} onClick={() => leaveReview({ kind: 'cancel' })}>{closed ? 'Close review history' : 'Cancel bill review'}</button>{!closed && !acceptedReceipt && <button type="button" className={button} disabled={busy || !!localDraft?.conflict} onClick={() => void run(async () => { await persistDraft('saved'); closeReview(); await loadReviews(); setNotice('Review saved for later. Source confirmations must be checked again when reopened.'); })}>Save for later</button>}</div>
    </form>}
    {pattern && <form aria-label="Approve bill arrival pattern" className="rounded-lg border border-agency p-3 space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => {
      const fields = { intervalMonths: pattern.intervalMonths, anchorDate: pattern.anchorDate, windowBeforeDays: pattern.windowBeforeDays, windowAfterDays: pattern.windowAfterDays, timeZone: pattern.timeZone, reviewReason: pattern.reason };
      await write(pattern.original ? `/api/bill-series/${pattern.original.id}` : '/api/bill-series', pattern.original ? 'PUT' : 'POST', pattern.original ? { ...fields, expectedRevision: pattern.original.revision, active: pattern.active } : { ...fields, occurrenceId: pattern.bill.id, expectedOccurrenceRevision: pattern.bill.revision });
      await refresh(); setPattern(null); setNotice('The arrival pattern was saved with your review. Invoice due dates remain separate.'); onSaved?.();
    }); }}><h4 className="font-medium">{pattern.original ? 'Review arrival pattern' : 'Approve recurring arrivals'} · {label(pattern.bill.facts.propertyId)} · {pattern.bill.facts.kind}</h4><p className="text-sm text-ink-secondary">Confirm the pattern you expect from this received bill. The anchor window must include its actual source arrival. An end-of-month anchor stays at month end. These dates predict arrivals, not invoice due dates.</p><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Arrival frequency<select aria-label="Arrival frequency" className={`${input} mt-1`} disabled={busy} value={pattern.intervalMonths} onChange={e => setPattern({ ...pattern, intervalMonths: Number(e.target.value) as 1 | 3 | 12 })}><option value={1}>Monthly</option><option value={3}>Quarterly</option><option value={12}>Yearly</option></select></label><label className="block text-sm">Observed anchor date<input type="date" className={`${input} mt-1`} disabled={busy} value={pattern.anchorDate} onChange={e => setPattern({ ...pattern, anchorDate: e.target.value })} /></label><label className="block text-sm">Days before anchor<input type="number" min={0} max={14} className={`${input} mt-1`} disabled={busy} value={pattern.windowBeforeDays} onChange={e => setPattern({ ...pattern, windowBeforeDays: Number(e.target.value) })} /></label><label className="block text-sm">Days after anchor<input type="number" min={0} max={14} className={`${input} mt-1`} disabled={busy} value={pattern.windowAfterDays} onChange={e => setPattern({ ...pattern, windowAfterDays: Number(e.target.value) })} /></label></div><label className="block text-sm">Arrival timezone<input className={`${input} mt-1`} disabled={busy} value={pattern.timeZone} onChange={e => setPattern({ ...pattern, timeZone: e.target.value })} placeholder="Australia/Brisbane" /></label><label className="block text-sm">Reason for this arrival pattern<input className={`${input} mt-1`} maxLength={1000} disabled={busy} value={pattern.reason} onChange={e => setPattern({ ...pattern, reason: e.target.value })} /></label>{pattern.original && <label className="flex min-h-11 gap-2 items-center text-sm"><input type="checkbox" checked={pattern.active} disabled={busy} onChange={e => setPattern({ ...pattern, active: e.target.checked })} />Pattern is active</label>}<div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || !pattern.reason.trim()}>{pattern.original ? 'Save arrival pattern revision' : 'Approve arrival pattern'}</button><button type="button" className={button} disabled={busy} onClick={() => setPattern(null)}>Cancel pattern review</button></div></form>}
    <div className="space-y-3"><h4 className="font-medium">Bill calendar</h4>{snapshot && <p className="text-sm text-ink-secondary">Showing {calendar.length} entries from {displayBillDate(snapshot.range.from)} to {displayBillDate(snapshot.range.to)}{snapshot.calendar.nextCursor ? ' · more entries available' : ' · all pages loaded'}. Predictions remain separate from actual due dates.</p>}<div className="flex flex-wrap gap-3 items-end"><label className="block text-sm">Calendar from<input type="date" className={`${input} mt-1`} value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></label><label className="block text-sm">Calendar to<input type="date" className={`${input} mt-1`} value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></label><button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(); })}>Show calendar range</button></div>{snapshot && !calendar.length && <p className="text-sm text-ink-secondary">No entries on this loaded calendar page. Check any remaining pages below.</p>}<ul className="grid gap-2 sm:grid-cols-2">{calendar.map(entry => <li key={entry.id} className="rounded-lg border border-line p-3 space-y-1 text-sm"><p className={`font-medium ${entry.type === 'expected-arrival' ? 'text-ink-secondary' : 'text-ink'}`}>{entry.type === 'expected-arrival' ? 'Expected arrival' : 'Actual due date'} · {displayBillDate(entry.date)}{entry.endDate !== entry.date ? ` – ${displayBillDate(entry.endDate)}` : ''}</p><p className="break-words">{label(entry.propertyId)} · {entry.kind} · {entry.vendor}</p><p className="text-xs text-ink-secondary">{entry.type === 'expected-arrival' ? 'Prediction from your approved arrival pattern. No invoice due date is implied.' : 'Date entered in the received bill’s source review.'}</p><button className={button} disabled={busy || editorOpen || !!pattern} onClick={() => void run(() => entry.billId ? openBill(entry.billId) : openPattern(entry.seriesId!))}>{entry.billId ? 'Open received bill' : 'Review arrival pattern'}</button></li>)}</ul>{snapshot?.calendar.nextCursor && <button className={button} disabled={busy} onClick={() => void run(() => loadMore('calendar'))}>Load more calendar entries</button>}</div>
    <div className="space-y-3"><h4 className="font-medium">Received bill records {snapshot ? `(${records.length} of ${snapshot.occurrences.total})` : ''}</h4>{snapshot && !records.length && <p className="text-sm text-ink-secondary">No bill records on this loaded page. Check any remaining pages below.</p>}<ul className="space-y-3">{records.map(row => <li key={row.id} id={row.id} className="rounded-lg border border-line p-3 space-y-2 text-sm"><div className="flex flex-wrap justify-between gap-2"><h5 className="font-medium break-words">{label(row.facts.propertyId)} · {row.facts.kind}</h5><span>{states[row.state]} · revision {row.revision}</span></div><p className="break-words">{row.facts.vendor} · {row.facts.amountCents === null ? 'Amount not confirmed' : new Intl.NumberFormat(undefined, { style: 'currency', currency: row.facts.currency }).format(row.facts.amountCents / 100)}</p><p>Invoice date: {displayBillDate(row.facts.invoiceDate)} · Actual due: {displayBillDate(row.facts.dueDate)}</p>{row.facts.note && <p className="whitespace-pre-wrap break-words">{row.facts.note}</p>}<p className="text-ink-secondary break-words">Review reason: {row.reviewReason}</p><details><summary className="min-h-11 cursor-pointer">Source and correction history ({row.history.length})</summary><p className="break-words">Current source: {row.source.message.subject} · {row.source.message.from}</p><p className="break-all text-xs">Message {row.source.message.id} · receipt {row.source.receiptId} · digest {row.source.digest}</p><p className="whitespace-pre-wrap break-words mt-2">{row.source.message.body}</p><ul className="mt-2 space-y-2">{row.history.map(version => <li key={version.revision} className="rounded border border-line p-2"><p>Revision {version.revision} · {states[version.state]} · due {displayBillDate(version.facts.dueDate)}</p><p className="break-words">{version.reviewReason} · reviewed by {version.reviewedBy}</p><p className="break-words">{version.facts.vendor} · {version.facts.kind} · {label(version.facts.propertyId)}</p><p className="break-all text-xs">Source {version.source.message.id} · {version.source.digest}</p><details><summary className="min-h-11 cursor-pointer">Earlier saved source text</summary><p className="whitespace-pre-wrap break-words">{version.source.message.body}</p></details></li>)}</ul></details><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || editorOpen || !!pattern} onClick={() => void run(() => openBill(row))}>Review or correct bill</button>{row.state !== 'cancelled' && <button className={button} disabled={busy || editorOpen || !!pattern} onClick={() => void run(() => openPatternForBill(row.id))}>Review recurring arrivals</button>}</div></li>)}</ul>{snapshot?.occurrences.nextCursor && <button className={button} disabled={busy} onClick={() => void run(() => loadMore('occurrences'))}>Load more bill records</button>}</div>
    {!!snapshot?.series.total && <details><summary className="min-h-11 cursor-pointer font-medium">Saved arrival patterns ({snapshot.series.items.length} of {snapshot.series.total})</summary><ul className="space-y-2">{snapshot.series.items.map(series => <li key={series.id} className="rounded border border-line p-3 text-sm space-y-2"><p className="break-words">{label(series.propertyId)} · {series.kind} · {series.vendor} · {series.active ? 'Active' : 'Paused'}</p><p>Every {series.intervalMonths} month{series.intervalMonths === 1 ? '' : 's'} · anchor {displayBillDate(series.anchorDate)} · {series.timeZone}</p><p className="break-words">{series.reviewReason}</p><button className={button} disabled={busy || editorOpen || !!pattern} onClick={() => void run(() => openPattern(series.id))}>Edit or pause arrival pattern</button><details><summary className="min-h-11 cursor-pointer">Pattern history ({series.history.length})</summary>{series.history.map(version => <p key={version.revision} className="break-words">Revision {version.revision} · {version.active ? 'Active' : 'Paused'} · every {version.intervalMonths} months from {displayBillDate(version.anchorDate)} · {version.reviewReason}</p>)}</details></li>)}</ul>{snapshot.series.nextCursor && <button className={button} disabled={busy} onClick={() => void run(() => loadMore('series'))}>Load more arrival patterns</button>}</details>}
    {!snapshot && !error && <p role="status" className="text-sm text-ink-secondary">Loading saved bill records…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}{snapshot ? ' Previously loaded records are retained; refresh before another change.' : ''}</p>}
    <p role="status" className="text-sm text-ink-secondary">{busy ? 'Waiting for the saved result…' : notice}</p>
  </section>;
}
