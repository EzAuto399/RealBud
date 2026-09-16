import { useEffect, useRef, useState } from 'react';
import type { CompanyStatus } from '@shared/company-api';
import type { SharedWorkItem, SharedWorkPerson, SharedWorkPurpose } from '@shared/company-work';
import { companyApi } from '@/lib/company-api';
import { SharedWorkDetails } from './SharedWorkDetails';
import type { SharedWorkEvidence } from '@shared/company-work';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'min-h-10 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50';
const muted = 'mt-2 text-sm leading-relaxed text-ink-muted';
const PURPOSES: Array<{ id: SharedWorkPurpose; label: string }> = [
  { id: 'share-result', label: 'Share result' },
  { id: 'request-review', label: 'Request review' },
  { id: 'handoff', label: 'Hand over work' },
];

function statusOf(cause: unknown): number | undefined {
  return cause && typeof cause === 'object' && typeof (cause as { status?: unknown }).status === 'number' ? (cause as { status: number }).status : undefined;
}
function ended(cause: unknown): boolean {
  return !!(cause && typeof cause === 'object' && (cause as { memberSessionEnded?: boolean }).memberSessionEnded);
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Shared work could not be updated. Try again.';
}
function stateLabel(state: SharedWorkItem['state']): string {
  return state === 'open' ? 'Awaiting colleague' : state === 'accepted' ? 'Accepted' : state === 'responded' ? 'Response ready' : 'Review closed';
}
function purposeLabel(purpose: SharedWorkPurpose): string {
  return PURPOSES.find(item => item.id === purpose)?.label ?? purpose;
}
function when(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

export function SharedWorkPanel({ initialDraft }: { initialDraft?: { title: string; summary: string } } = {}) {
  const [expanded, setExpanded] = useState(false);
  const [company, setCompany] = useState<CompanyStatus | null>(null);
  const [members, setMembers] = useState<SharedWorkPerson[]>([]);
  const [items, setItems] = useState<SharedWorkItem[]>([]);
  const [filter, setFilter] = useState<'with-me' | 'by-me'>('with-me');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [summary, setSummary] = useState(initialDraft?.summary ?? '');
  const [purpose, setPurpose] = useState<SharedWorkPurpose>('share-result');
  const [recipientId, setRecipientId] = useState('');
  const [preview, setPreview] = useState(false);
  const [shareLocked, setShareLocked] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [evidence, setEvidence] = useState<SharedWorkEvidence>({ label: '', sourceRef: '', sourceVersion: '', text: '' });
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const loadGeneration = useRef(0);
  const identityRef = useRef<{ companyId: string; memberId: string } | null>(null);
  const requestId = useRef('');
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const previousPreview = useRef(false);

  const clearVisible = (sessionLost = false) => {
    setMembers([]);
    setItems([]);
    if (!sessionLost) return;
    setSelectedId('');
    setIncludeEvidence(false);
    setEvidence({ label: '', sourceRef: '', sourceVersion: '', text: '' });
    setPreview(false);
    setShareLocked(false);
    requestId.current = '';
    setTitle('');
    setSummary('');
    setPage(0);
    setRecipientId('');
  };

  const load = async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const status = await companyApi.status();
      const next = status.company && status.member ? { companyId: status.company.id, memberId: status.member.id } : null;
      if (!mounted.current || generation !== loadGeneration.current) return;
      const previous = identityRef.current;
      const identityChanged = !!previous && (!next || previous.companyId !== next.companyId || previous.memberId !== next.memberId);
      identityRef.current = next;
      if (identityChanged) clearVisible(true);
      if (!mounted.current || generation !== loadGeneration.current) return;
      setCompany(status);
      if (!next) {
        setMembers([]);
        setItems([]);
        setSelectedId('');
        return;
      }
      const [people, work] = await Promise.all([companyApi.workMembers(), companyApi.sharedWork({ offset: page * 10, filter })]);
      if (!mounted.current || generation !== loadGeneration.current) return;
      setMembers(people.members);
      setItems(work.items);
    } catch (cause) {
      if (!mounted.current || generation !== loadGeneration.current) return;
      const sessionLost = ended(cause) || statusOf(cause) === 401;
      clearVisible(sessionLost);
      setNotice('');
      if (sessionLost) setCompany(current => current ? { ...current, member: undefined } : null);
      setError(messageOf(cause));
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadGeneration.current++; };
  }, []);
  useEffect(() => {
    if (preview) reviewHeading.current?.focus();
    else if (previousPreview.current) titleField.current?.focus();
    previousPreview.current = preview;
  }, [preview]);

  useEffect(() => companyApi.subscribeSession(() => {
    loadGeneration.current++;
    identityRef.current = null;
    clearVisible(true);
    setCompany(null);
    setNotice('');
    setError('');
    setLoading(false);
    setSessionEpoch(epoch => epoch + 1);
  }), []);

  useEffect(() => {
    if (!expanded) return;
    void load();
    const onFocus = () => { if (document.visibilityState !== 'hidden') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      loadGeneration.current++;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [expanded, filter, page, sessionEpoch]);

  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const identity = `${identityRef.current?.companyId ?? ''}:${identityRef.current?.memberId ?? ''}`;
    try {
      await action();
    } catch (cause) {
      if (!mounted.current) return;
      if (`${identityRef.current?.companyId ?? ''}:${identityRef.current?.memberId ?? ''}` !== identity) return;
      if (ended(cause) || statusOf(cause) === 401) {
        clearVisible(true);
        setCompany(current => current ? { ...current, member: undefined } : null);
      } else if ([403, 404, 503].includes(statusOf(cause) ?? 0)) {
        clearVisible(false);
      }
      setError(statusOf(cause) === 409
        ? 'This shared work changed. Refresh to see the current revision. Your unsaved text is still here.'
        : messageOf(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const sameIdentity = async () => {
    const version = companyApi.sessionVersion();
    const expected = identityRef.current;
    const current = await companyApi.status();
    const check = () => {
      if (!mounted.current || version !== companyApi.sessionVersion() || !expected ||
          !current.company || !current.member || current.company.id !== expected.companyId ||
          current.member.id !== expected.memberId || identityRef.current?.companyId !== expected.companyId || identityRef.current?.memberId !== expected.memberId) {
        throw new Error('Company sign-in changed. Refresh and review shared work before continuing.');
      }
    };
    check();
    return check;
  };

  const shareNow = async () => {
    const startVersion = companyApi.sessionVersion();
    const check = await sameIdentity();
    check();
    if (!requestId.current) requestId.current = crypto.randomUUID();
    let saved: SharedWorkItem;
    try {
      const { item } = await companyApi.shareWork({
        requestId: requestId.current, title, summary, purpose, recipientMemberIds: [recipientId],
        assigneeMemberId: purpose === 'share-result' ? null : recipientId,
        evidence: includeEvidence ? evidence : null,
      });
      check();
      // Audience is current access, not the immutable creation request. It may
      // shrink before an idempotent response arrives; the kernel checks that
      // the request id and original recipient selection match on every retry.
      if (item.id !== requestId.current || item.title !== title || item.summary !== summary ||
          item.purpose !== purpose || item.owner.id !== identityRef.current?.memberId ||
          JSON.stringify(item.evidence ? { label: item.evidence.label, sourceRef: item.evidence.sourceRef, sourceVersion: item.evidence.sourceVersion, text: item.evidence.text } : null) !== JSON.stringify(includeEvidence ? evidence : null)) {
        throw new Error('The saved shared work did not match the preview. Retry the same request to check it.');
      }
      saved = item;
    } catch (cause) {
      if (!mounted.current || !identityRef.current || startVersion !== companyApi.sessionVersion()) throw cause;
      const status = statusOf(cause);
      if (status !== 400 && status !== 401 && status !== 403) setShareLocked(true);
      throw cause;
    }
    // A successful write is final even if a later refresh cannot reach the host.
    // Do not move refresh into the share catch or replay a successful mutation.
    setItems(previous => [saved, ...previous.filter(item => item.id !== saved.id)].slice(0, 10));
    setSelectedId(saved.id);
    setFilter('by-me'); setPage(0);
    setShareLocked(false); setPreview(false);
    setTitle(''); setSummary(''); setRecipientId(''); requestId.current = '';
    setIncludeEvidence(false); setEvidence({ label: '', sourceRef: '', sourceVersion: '', text: '' });
    setNotice(saved.state === 'closed' ? 'This request was already saved and is now closed.'
      : saved.state === 'responded' ? 'This request was already saved and has a response.' : 'Reviewed work saved. Its current audience is shown below.');
  };

  const me = company?.member?.id;
  const others = members.filter(person => person.id !== me);
  const visible = items.filter(item => (filter === 'by-me'
    ? item.owner.id === me
    : item.owner.id !== me && (item.assignee?.id === me || item.audience.some(person => person.id === me))));
  const selected = items.find(item => item.id === selectedId);
  const recipient = others.find(person => person.id === recipientId);
  const editingLocked = busy || shareLocked;
  const evidenceReady = !includeEvidence || Object.values(evidence).every(value => value.trim());
  const evidencePreview = includeEvidence && <div className="mt-3 border-t border-line pt-3"><p className="font-medium">Evidence copy: {evidence.label}</p><p className={muted}>{evidence.sourceRef} · {evidence.sourceVersion}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{evidence.text}</p></div>;

  return (
    <section aria-label="Shared work" className="mt-5 border-t border-line bg-paper pt-4 break-words">
      <button type="button" className={button} aria-expanded={expanded} aria-controls="shared-work-panel" onClick={() => setExpanded(open => !open)}>Shared work</button>
      {expanded && (
        <div id="shared-work-panel" className="mt-3" aria-busy={loading || busy}>
          <p className={muted}>Share a result or ask a colleague to review it. Only content you review and select is shared. Your chats and connected accounts stay private.</p>
          {loading && <p role="status" className={muted}>Loading shared work…</p>}
          {error && <p id="shared-work-error" role="alert" className="mt-2 text-sm text-danger">{error}</p>}
          <p role="status" className={muted}>{notice}</p>
          {!company?.member && !loading && <p className={muted}>Sign in under You → This office if needed, then refresh shared work.</p>}
          {company?.member && (
            <>
              <p className="mt-3 text-sm text-ink">{company.company?.name} · {company.member.displayName}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={`${button} ${filter === 'with-me' ? 'bg-raised' : ''}`} aria-pressed={filter === 'with-me'} disabled={busy} onClick={() => { setFilter('with-me'); setPage(0); setSelectedId(''); }}>Shared with me</button>
                <button type="button" className={`${button} ${filter === 'by-me' ? 'bg-raised' : ''}`} aria-pressed={filter === 'by-me'} disabled={busy} onClick={() => { setFilter('by-me'); setPage(0); setSelectedId(''); }}>Shared by me</button>
              </div>
              <div className="mt-3 grid gap-3 min-[800px]:grid-cols-2">
                <div className="rounded-lg border border-line bg-sheet p-3">
                  <h3 className="text-[14px] font-medium text-ink">{filter === 'with-me' ? 'Shared with me' : 'Shared by me'}</h3>
                  {visible.length === 0 && !loading && !error && <p className={muted}>{page > 0 ? 'No more work on this page. Go to the previous page or refresh.' : filter === 'with-me' ? 'Nothing has been shared with you yet.' : 'You have not shared reviewed work yet.'}</p>}
                  <ul className="mt-2 space-y-2">
                    {visible.map(item => (
                      <li key={item.id}>
                        <button type="button" aria-current={selectedId === item.id ? 'true' : undefined} className={`w-full rounded-lg border border-line bg-paper p-3 text-left ${selectedId === item.id ? 'outline outline-2 outline-agency' : ''}`} disabled={busy} onClick={() => setSelectedId(item.id)}>
                          <p className="text-sm font-medium text-ink">{item.title}</p>
                          <p className="text-[12px] text-ink-muted">{stateLabel(item.state)} · {purposeLabel(item.purpose)} · {item.owner.displayName} · {when(item.updatedAt)}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {(page > 0 || items.length === 10) && <div className="mt-3 flex items-center gap-2">
                    <button className={button} disabled={busy || loading || page === 0} onClick={() => { setPage(p => p - 1); setSelectedId(''); }}>Previous page</button>
                    <span className="text-xs">Page {page + 1}</span>
                    <button className={button} disabled={busy || loading || items.length < 10} onClick={() => { setPage(p => p + 1); setSelectedId(''); }}>Next page</button>
                  </div>}
                  {selected && <SharedWorkDetails key={`${me}:${selected.id}`} item={selected} members={others}
                    busy={busy || loading} verifyIdentity={sameIdentity} perform={perform}
                    onSaved={item => setItems(previous => previous.map(old => old.id === item.id ? item : old))}
                    onNotice={setNotice} />}
                </div>
                <div className="rounded-lg border border-line bg-sheet p-3">
                  <h3 className="text-[14px] font-medium text-ink">Share reviewed work</h3>
                  {error.includes('needs service recovery') ? <p className={muted}>Sharing is paused. After the record is repaired, refresh to continue. Your draft is kept until you leave this view.</p> : loading || (error && others.length === 0) ? <p className={muted}>Refresh the company connection to choose a recipient. Your draft is kept until you leave this view.</p> : others.length === 0 ? (
                    <p className={muted}>Invite a colleague under You → This office before sharing work.</p>
                  ) : shareLocked ? (
                    <>
                      <p role="status" className={muted}>The share may already exist. Retry uses the same request. Cancel does not undo a share that already landed. Refresh to check.</p>
                      <p className="mt-2 text-sm text-ink">Audience: {recipient?.displayName ?? 'Unknown'}</p>
                      <p className="text-sm text-ink">Purpose: {purposeLabel(purpose)}</p>
                      <p className="text-sm text-ink">Title: {title}</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{summary}</p>
                      <button type="button" className={`${button} mt-2 mr-2`} disabled={busy} onClick={() => void perform(shareNow)}>Retry share</button>
                      <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => { setShareLocked(false); setPreview(false); requestId.current = ''; setNotice('Cancelled this attempt. If the host already saved it, it will still appear after refresh.'); }}>Cancel share</button>
                    </>
                  ) : preview ? (
                    <>
                      <h4 ref={reviewHeading} tabIndex={-1} className="mt-2 font-medium focus:outline-agency">Review before sharing</h4>
                      <p className="mt-2 text-sm text-ink">Audience: {recipient?.displayName ?? 'Unknown'}</p>
                      <p className="text-sm text-ink">Purpose: {purposeLabel(purpose)}</p>
                      {purpose !== 'share-result' && <p className="text-sm text-ink">Next person: {recipient?.displayName ?? 'Unknown'}</p>}
                      <p className="text-sm text-ink">Title: {title}</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{summary}</p>
                      {evidencePreview}
                      <p className={muted}>The selected person receives this summary{includeEvidence ? ' and evidence copy' : ''}. Your original files, connected accounts and computer remain private. Closing this review does not complete a business action.</p>
                      <button type="button" className={`${button} mt-2 mr-2`} disabled={busy} onClick={() => void perform(shareNow)}>Share reviewed work</button>
                      <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => setPreview(false)}>Back to edit</button>
                    </>
                  ) : (
                    <>
                      <label htmlFor="shared-work-title" className="mt-2 block text-sm text-ink">Title</label>
                      <input ref={titleField} id="shared-work-title" className={field} maxLength={160} value={title} disabled={editingLocked} onChange={event => setTitle(event.target.value)} />
                      <label htmlFor="shared-work-summary" className="mt-2 block text-sm text-ink">Summary</label>
                      <textarea id="shared-work-summary" className={`${field} min-h-24`} maxLength={4000} value={summary} disabled={editingLocked} onChange={event => setSummary(event.target.value)} />
                      <details className="mt-3 border-t border-line pt-3">
                        <summary className="min-h-10 cursor-pointer text-sm">Include an evidence copy</summary>
                        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={includeEvidence} disabled={editingLocked} onChange={event => setIncludeEvidence(event.target.checked)} />Share only the text below</label>
                        <p className={muted}>Copy the relevant source text so your colleague can read it on their computer. Check it for private information. A source reference is a label, not permission to open the original.</p>
                        {includeEvidence && <>{(['label', 'sourceRef', 'sourceVersion'] as const).map(key => <label key={key} className="mt-2 block text-sm">{key === 'label' ? 'Evidence title' : key === 'sourceRef' ? 'Source reference' : 'Source version or date'}<input className={field} maxLength={key === 'sourceRef' ? 500 : key === 'label' ? 160 : 120} value={evidence[key]} disabled={editingLocked} onChange={event => setEvidence(old => ({ ...old, [key]: event.target.value }))} /></label>)}
                          <label className="mt-2 block text-sm">Selected source text<textarea className={`${field} min-h-32`} maxLength={8000} value={evidence.text} disabled={editingLocked} onChange={event => setEvidence(old => ({ ...old, text: event.target.value }))} /></label></>}
                      </details>
                      <p id="shared-work-purpose-label" className="mt-2 text-sm text-ink">Purpose</p>
                      <div role="radiogroup" aria-labelledby="shared-work-purpose-label">
                        {PURPOSES.map(option => (
                          <label key={option.id} className="flex min-h-10 items-center gap-2 text-sm text-ink">
                            <input type="radio" name="shared-work-purpose" checked={purpose === option.id} disabled={editingLocked} onChange={() => setPurpose(option.id)} />
                            {option.label}
                          </label>
                        ))}
                      </div>
                      <label htmlFor="shared-work-recipient" className="mt-2 block text-sm text-ink">Recipient</label>
                      <select id="shared-work-recipient" className={field} value={recipientId} disabled={editingLocked} onChange={event => setRecipientId(event.target.value)}>
                        <option value="">Select a person</option>
                        {others.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}
                      </select>
                      {purpose !== 'share-result' && recipient && <p className={muted}>Next person: {recipient.displayName}</p>}
                      <button type="button" className={`${button} mt-3`} disabled={editingLocked || !title.trim() || !summary.trim() || !recipientId || !evidenceReady} onClick={() => setPreview(true)}>Review share</button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void load()}>{loading ? 'Loading…' : 'Refresh shared work'}</button>
        </div>
      )}
    </section>
  );
}
