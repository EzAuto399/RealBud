import { useEffect, useRef, useState } from 'react';
import type { SharedWorkActivity, SharedWorkItem, SharedWorkPerson } from '@shared/company-work';
import { companyApi } from '@/lib/company-api';

const button = 'min-h-10 rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const field = 'min-h-10 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm';
const when = (at: string) => new Date(at).toLocaleString();
const verbs = { shared: 'Shared the reviewed work', accepted: 'Accepted responsibility', reassigned: 'Reassigned the work', responded: 'Saved a response', closed: 'Closed the review' };

export function SharedWorkDetails({ item, members, busy, verifyIdentity, perform, onSaved, onNotice }: {
  item: SharedWorkItem; members: SharedWorkPerson[]; busy: boolean;
  verifyIdentity: () => Promise<() => void>;
  perform: (action: () => Promise<void>) => Promise<void>;
  onSaved: (item: SharedWorkItem) => void; onNotice: (message: string) => void;
}) {
  const [response, setResponse] = useState(item.response);
  const [draftRevision, setDraftRevision] = useState(item.revision);
  const [dirty, setDirty] = useState(false);
  const [target, setTarget] = useState('');
  const [confirmTarget, setConfirmTarget] = useState('');
  const [history, setHistory] = useState<{ events: SharedWorkActivity[]; hasMore: boolean } | null>(null);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setHistory(null); setConfirmTarget('');
    if (!dirty) { setResponse(item.response); setDraftRevision(item.revision); }
  }, [item.revision, dirty]);
  const candidates = members.filter(person => person.id !== item.owner.id && person.id !== item.assignee?.id &&
    (item.actions.addRecipient || item.audience.some(recipient => recipient.id === person.id)));
  const chosen = candidates.find(person => person.id === target);
  const mutate = (action: () => Promise<{ item: SharedWorkItem }>, message: string) => void perform(async () => {
    const check = await verifyIdentity(); check();
    if (!mounted.current) return;
    const saved = await action(); check();
    if (!mounted.current) return;
    onSaved(saved.item); onNotice(message); setConfirmTarget(''); setTarget('');
  });
  const loadHistory = (older = false) => void perform(async () => {
    const check = await verifyIdentity(); check();
    const page = await companyApi.sharedWorkHistory({ id: item.id,
      ...(older && history?.events.length ? { beforeRevision: history.events.at(-1)!.revision } : {}) });
    check(); if (!mounted.current) return;
    setHistory(current => ({ events: older && current ? [...current.events, ...page.events] : page.events, hasMore: page.hasMore }));
  });
  return <article aria-label={item.title} className="mt-3 border-t border-line pt-4 text-sm text-ink">
    <h4 ref={heading} tabIndex={-1} className="font-semibold focus:outline-agency">{item.title}</h4>
    <p className="mt-2">From {item.owner.displayName} · {when(item.updatedAt)}</p>
    <p className="mt-1">Audience: {item.audience.map(person => person.displayName).join(', ')}</p>
    <p className="mt-2 font-medium">{item.state === 'closed' ? 'Review closed' : item.state === 'responded' ? `Response ready for ${item.ownerAvailable === false ? item.assignee?.displayName : item.owner.displayName}`
      : item.acceptedBy ? `${item.acceptedBy.displayName} accepted responsibility` : item.assignee ? `Awaiting ${item.assignee.displayName}` : 'Shared for reference'}</p>
    {item.ownerAvailable === false && <p role="status" className="mt-2">The sender is no longer an active member. The assigned colleague can close this review or reassign it to an existing participant with write access.</p>}
    {item.assignee && !item.audience.some(person => person.id === item.assignee!.id) && item.state !== 'closed' && <p role="status" className="mt-2 text-danger">{item.assignee.displayName} no longer has access. Reassign this work to continue.</p>}
    <p className="mt-3 whitespace-pre-wrap break-words">{item.summary}</p>
    {item.evidence ? <details className="mt-3 rounded-lg border border-line p-3">
      <summary className="min-h-10 cursor-pointer font-medium">Evidence copy: {item.evidence.label}</summary>
      <p className="mt-2 break-words">{item.evidence.sourceRef} · {item.evidence.sourceVersion}</p>
      <p className="mt-2 text-ink-muted">Reviewed text copy. Access to the original source is separate.</p>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm">{item.evidence.text}</pre>
    </details> : <p className="mt-2 text-ink-muted">No evidence copy included. Ask the sender for the source if needed.</p>}
    {item.response && <div className="mt-3 border-l-2 border-agency pl-3"><p className="font-medium">Saved response</p><p className="mt-1 whitespace-pre-wrap break-words">{item.response}</p></div>}
    {item.actions.accept && <div className="mt-3"><p>Accepting names you as responsible for this review. It grants no computer or account access.</p>
      <button className={`${button} mt-2`} disabled={busy} onClick={() => mutate(() => companyApi.acceptSharedWork({ id: item.id, expectedRevision: item.revision }), 'Responsibility accepted. Review the selected evidence, then save your response.')}>Accept responsibility</button></div>}
    {item.actions.respond && <div className="mt-3">
      <label className="block">Your reviewed response<textarea className={`${field} mt-1 min-h-24`} maxLength={4000} value={response} disabled={busy} onChange={event => { setDirty(true); setResponse(event.target.value); }} /></label>
      {dirty && draftRevision !== item.revision && <div role="status" className="mt-2"><p>This work changed while you were writing. Your draft is kept. Compare it with the saved response above before continuing.</p><button className={`${button} mt-2`} disabled={busy} onClick={() => setDraftRevision(item.revision)}>I reviewed the change; keep my draft</button></div>}
      <button className={`${button} mt-2`} disabled={busy || !response.trim() || response === item.response || draftRevision !== item.revision} onClick={() => mutate(async () => {
        const result = await companyApi.respondToSharedWork({ id: item.id, expectedRevision: draftRevision, response });
        if (mounted.current) { setDirty(false); setDraftRevision(result.item.revision); }
        return result;
      }, 'Response saved for the participants to review.')}>Save response</button>
    </div>}
    {item.state !== 'closed' && !item.actions.accept && !item.actions.respond && !item.actions.close && <p className="mt-3 text-ink-muted">No action is available with your current permission. Ask the responsible colleague if you need to contribute.</p>}
    {item.actions.close && <div className="mt-3"><button className={button} disabled={busy} onClick={() => mutate(() => companyApi.closeSharedWork({ id: item.id, expectedRevision: item.revision }), 'Review closed. No payment, message or other business action was performed.')}>Close review</button><p className="mt-1 text-ink-muted">Closes this review only. Saved work and history remain available.</p></div>}
    {item.actions.reassign && <details className="mt-3 border-t border-line pt-3"><summary className="min-h-10 cursor-pointer">Reassign responsibility</summary>
      <label className="block">Next colleague<select className={`${field} mt-1`} disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setConfirmTarget(''); }}><option value="">Select a colleague</option>{candidates.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
      {chosen && <><p className="mt-2">{chosen.displayName} will receive this summary, evidence copy and full review history. Existing participants keep access. The new colleague must accept responsibility.</p>
        {confirmTarget === target ? <button className={`${button} mt-2`} disabled={busy} onClick={() => mutate(() => companyApi.reassignSharedWork({ id: item.id, expectedRevision: item.revision, assigneeMemberId: target }), 'Reassigned. The new colleague needs to accept responsibility.')}>Confirm reassignment to {chosen.displayName}</button>
          : <button className={`${button} mt-2`} disabled={busy} onClick={() => setConfirmTarget(target)}>Review reassignment</button>}</>}
      {!candidates.length && <p className="mt-2 text-ink-muted">No eligible colleague is available. Invite a colleague or ask an existing participant to restore the required permission.</p>}
    </details>}
    <div className="mt-3 border-t border-line pt-3"><button className={button} disabled={busy} onClick={() => loadHistory()}>View activity history</button>
      {history && <><ol aria-label="Review activity" className="mt-3 space-y-3">{history.events.map(event => <li key={event.revision}><p>{event.actor.displayName} · {verbs[event.action]}</p><p className="text-xs text-ink-muted">{when(event.at)} · revision {event.revision}{event.assignee ? ` · ${event.assignee.displayName}` : ''}</p>{event.action === 'responded' && <p className="mt-1 whitespace-pre-wrap break-words">{event.response}</p>}</li>)}</ol>{history.hasMore && <button className={`${button} mt-2`} disabled={busy} onClick={() => loadHistory(true)}>Earlier activity</button>}</>}
    </div>
  </article>;
}
