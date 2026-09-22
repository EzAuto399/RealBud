import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/state/store';
import { cn } from '@/lib/cn';
import {
  MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewItem, type MemoryReviewPage, type MemoryReviewPreview,
} from '@shared/hermes-memory-review';
import { Card } from './SettingsPrimitives';
import { MemoryRecoveryPanel, MemoryReviewRequestCoordinator } from './MemoryRecoveryPanel';

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Decision = 'approve' | 'reject';
type UncertainDecision = { digest: string | null; decision: Decision | null; item: MemoryReviewItem };
type ReviewState = {
  items: MemoryReviewItem[]; cursor: string | null; total: number; held: number; loaded: boolean;
  selected: MemoryReviewItem | null; missing: boolean; needsCheck: boolean; preview: MemoryReviewPreview | null; confirmed: boolean;
  busy: 'list' | 'preview' | 'decision' | null; error: string; notice: string;
};
const unknownResult = 'The decision result could not be confirmed. Check saved reviews before trying again.';
const missingResult = 'This review is no longer listed. Its result cannot be confirmed here.';
const states: Record<MemoryReviewItem['state'], string> = {
  pending: 'Ready for review', applied: 'Saved', rejected: 'Rejected',
  'recovery-required': 'Needs recovery', unavailable: 'Needs service review',
};
const targets = { memory: 'Bud’s working preferences', user: 'Your preferences' };
const origins = { foreground: 'Proposed in a conversation', background_review: 'Proposed during a background review' };
const actions = { add: 'Add', replace: 'Replace', remove: 'Remove', batch: 'Combined change' };
const button = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';

function safeError(cause: unknown): string {
  if (cause instanceof Error) {
    // Never interpolate transport errors, file paths, account names or unknown server fields.
    const known = Object.values(MEMORY_REVIEW_ERRORS).find(message => message === cause.message);
    if (known) return known;
  }
  return MEMORY_REVIEW_ERRORS.unavailable;
}
function pageResponse(raw: unknown, cursor: string | null): MemoryReviewPage {
  const page = parseMemoryReviewPage(raw);
  if (!page || page.items.some((item, index) => item.id <= (index ? page.items[index - 1].id : cursor ?? '')) ||
    page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.id) throw new Error(MEMORY_REVIEW_ERRORS.unavailable);
  return page;
}

/** Coordinates this screen's reads and single decisions. Persisted server state owns the result. */
export class MemoryReviewSession {
  private state: ReviewState = { items: [], cursor: null, total: 0, held: 0, loaded: false, selected: null, missing: false, needsCheck: false, preview: null, confirmed: false, busy: null, error: '', notice: '' };
  private listeners = new Set<() => void>();
  private revision = 0;
  private active = true;
  private deciding = false;
  private uncertain = new Map<string, UncertainDecision>();
  private activeIntent: UncertainDecision | null = null;
  private task: Promise<void> | null = null;
  private restartPending = false;
  constructor(private request: Request = (path, init) => api(path, init, { timeoutMs: 35_000 })) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<ReviewState>) { if (!this.active) return; this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); }
  private current(version: number) { return this.active && this.revision === version; }
  private own(work: () => Promise<void>): Promise<void> {
    const task = work().finally(() => {
      if (this.task === task) this.task = null;
      if (this.active && this.restartPending) {
        this.restartPending = false;
        this.update({ busy: null, preview: null, confirmed: false });
        void this.refresh();
      }
    });
    this.task = task;
    return task;
  }
  start() {
    const restarted = !this.active; this.active = true;
    if (restarted) this.update({ preview: null, confirmed: false, needsCheck: !!this.state.selected && this.uncertain.has(this.state.selected.id) });
    // StrictMode/reconnected views must drain the previous request before the
    // next lifecycle reads. Normal repeated starts leave a valid read alone.
    if (this.task) { if (restarted) this.restartPending = true; return; }
    this.update({ busy: null }); void this.refresh();
  }
  stop() {
    if (this.deciding && this.activeIntent) this.uncertain.set(this.activeIntent.item.id, this.activeIntent);
    this.active = false; this.restartPending = false; this.revision++;
  }
  confirm(value: boolean) { this.update({ confirmed: !!this.state.preview && !this.state.busy && !this.state.missing && value }); }

  async refresh(more = false) {
    if (!this.active || this.task || this.deciding || this.state.busy || more && !this.state.cursor) return;
    await this.own(() => this.readPage(more));
  }
  private async readPage(more: boolean, afterFailure = '') {
    const version = ++this.revision, cursor = more ? this.state.cursor : null, selectedId = this.state.selected?.id;
    this.update({ preview: null, confirmed: false, busy: 'list', error: '', notice: afterFailure });
    try {
      const page = pageResponse(await this.request(`${MEMORY_REVIEW_API}${cursor ? `?cursor=${cursor}` : ''}`), cursor);
      if (!this.current(version)) return;
      let selected = selectedId ? page.items.find(item => item.id === selectedId) ?? null : null;
      // IDs and cursors are stable ordered identifiers. One additional bounded page finds
      // the selected receipt without walking the entire history after a lost response.
      if (selectedId && !selected) {
        const prior = Number.parseInt(selectedId, 16) - 1;
        const anchor = prior < 0 ? null : prior.toString(16).padStart(8, '0');
        const focused = pageResponse(await this.request(`${MEMORY_REVIEW_API}${anchor ? `?cursor=${anchor}` : ''}`), anchor);
        if (!this.current(version)) return;
        selected = focused.items.find(item => item.id === selectedId) ?? null;
      }
      const expected = selectedId ? this.uncertain.get(selectedId) : undefined;
      const conflict = !!selected && !!expected?.digest && selected.state !== 'pending' &&
        (selected.reviewDigest !== expected.digest || selected.decision !== expected.decision);
      if (conflict) selected = expected!.item;
      else if (selected) this.uncertain.delete(selected.id);
      else if (selectedId && this.state.selected && !expected) this.uncertain.set(selectedId, { digest: null, decision: null, item: this.state.selected });
      const items = more ? [...this.state.items.filter(item => !page.items.some(row => row.id === item.id)), ...page.items] : page.items;
      this.update({
        items: selected ? items.map(item => item.id === selected.id ? selected : item) : items,
        cursor: page.nextCursor, total: page.total, held: page.held, loaded: true,
        selected: selected ?? this.state.selected, missing: !!selectedId && !selected, needsCheck: conflict || !!selectedId && !selected, busy: null,
        error: conflict ? MEMORY_REVIEW_ERRORS.conflict : selectedId && !selected ? missingResult : selected?.state === 'applied' || selected?.state === 'rejected' ? '' : afterFailure,
        notice: conflict ? 'The saved record does not match the decision you reviewed. Check its saved state before continuing.' : selected?.state === 'applied' ? 'The saved record confirms this memory change was applied. Start a new conversation to use the updated preferences.'
          : selected?.state === 'rejected' ? 'The saved record confirms this proposal was rejected.'
          : afterFailure ? 'Saved reviews checked. Review the current state before continuing.' : 'Saved reviews checked.',
      });
    } catch (cause) {
      if (this.current(version)) this.update({ busy: null, preview: null, confirmed: false, error: afterFailure || safeError(cause), notice: '' });
    }
  }

  async select(id: string) {
    if (!this.active || this.task || this.deciding || this.state.busy) return;
    await this.own(() => this.readSelection(id));
  }
  private async readSelection(id: string) {
    const item = this.uncertain.get(id)?.item ?? this.state.items.find(row => row.id === id) ?? (this.state.selected?.id === id ? this.state.selected : null);
    if (!item) return;
    const version = ++this.revision;
    this.update({ selected: item, missing: false, needsCheck: this.uncertain.has(id), preview: null, confirmed: false, busy: null, error: '', notice: '' });
    if (this.uncertain.has(id)) { await this.readPage(false); return; }
    if (item.state !== 'pending') return;
    this.update({ busy: 'preview' });
    try {
      const preview = parseMemoryReviewPreview(await this.request(`${MEMORY_REVIEW_API}/${id}`));
      if (!this.current(version)) return;
      if (!preview || preview.id !== id || preview.target !== item.target || preview.action !== item.action || preview.origin !== item.origin || preview.createdAt !== item.createdAt) throw new Error(MEMORY_REVIEW_ERRORS['stale-review']);
      this.update({ preview, busy: null });
    } catch (cause) {
      if (this.current(version)) this.update({ preview: null, confirmed: false, busy: null, error: safeError(cause) });
    }
  }

  async decide(decision: Decision, resume = false) {
    if (!this.active || this.task || this.state.busy) return;
    await this.own(() => this.makeDecision(decision, resume));
  }
  private async makeDecision(decision: Decision, resume: boolean) {
    if (this.deciding || this.state.busy || this.state.missing) return;
    const { selected, preview, confirmed } = this.state;
    if (!selected || this.uncertain.has(selected.id)) return;
    const digest = resume ? selected.reviewDigest : preview?.reviewDigest;
    if (resume ? selected.state !== 'recovery-required' || selected.decision !== decision || !digest
      : selected.state !== 'pending' || !preview || preview.id !== selected.id || decision === 'approve' && !confirmed) return;
    if (!digest) return;
    const intent = { digest, decision, item: selected };
    this.activeIntent = intent;
    this.deciding = true;
    const version = ++this.revision;
    this.update({ busy: 'decision', confirmed: false, error: '', notice: 'Saving your decision and checking its result…' });
    try {
      const result = parseMemoryReviewDecision(await this.request(`${MEMORY_REVIEW_API}/${selected.id}/decision`, {
        method: 'POST', body: JSON.stringify({ expectedDigest: digest, decision }),
      }));
      if (!this.current(version)) return;
      if (!result || result.id !== selected.id || result.reviewDigest !== digest || result.state !== (decision === 'approve' ? 'applied' : 'rejected')) throw new Error(unknownResult);
      const saved: MemoryReviewItem = { ...selected, state: result.state, decision, reviewDigest: result.reviewDigest };
      this.update({ selected: saved, items: this.state.items.map(item => item.id === saved.id ? saved : item), preview: null, confirmed: false, busy: null,
        notice: result.state === 'applied' ? 'The saved result confirms this memory change was applied. Start a new conversation to use the updated preferences.' : 'This proposal was rejected. Your saved preferences were not changed.' });
    } catch (cause) {
      if (this.current(version)) {
        this.uncertain.set(selected.id, intent);
        this.update({ preview: null, confirmed: false, needsCheck: true });
        await this.readPage(false, safeError(cause) === MEMORY_REVIEW_ERRORS.unavailable ? unknownResult : safeError(cause));
      }
    } finally { this.deciding = false; this.activeIntent = null; }
  }
}

/** A complete literal value, with its own keyboard-scrollable region. */
export function MemoryReviewText({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 space-y-2"><h5 className="text-sm font-medium">{label}</h5>
    {value.length === 0 && <p className="text-sm text-ink-muted">Empty — no saved text.</p>}
    <pre role="region" aria-label={label} tabIndex={0} className="max-h-80 min-h-16 overflow-auto rounded border border-line bg-inset p-3 font-mono text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-agency" style={{ whiteSpace: 'pre', tabSize: 4 }}>{value}</pre>
    <p className="text-xs text-ink-muted">{[...value].length.toLocaleString()} characters · complete text, with spacing preserved</p>
  </div>;
}

export function MemoryReviewPanel() {
  const [coordinator] = useState(() => new MemoryReviewRequestCoordinator());
  const [session] = useState(() => new MemoryReviewSession(coordinator.request));
  const requestBusy = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { session.start(); return () => session.stop(); }, [session]);
  const { selected, preview, busy } = state;
  const blocked = !!busy || requestBusy;
  return <section aria-label="Bud memory reviews" aria-busy={blocked}><Card title="Bud’s memory" subtitle="Review what Bud proposes to remember for future conversations.">
    <div className="space-y-4 text-sm">
      <p className="text-ink-secondary">These preferences guide future conversations. They do not update business records or grant permission to do work. Saved changes may require a new conversation.</p>
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className={button} disabled={blocked} onClick={() => void session.refresh()}>Refresh memory reviews</button>{state.loaded && <p className="text-ink-muted">{state.items.length} of {state.total} reviews shown</p>}</div>
      {!state.loaded && !state.error && <p role="status">Checking saved memory reviews…</p>}
      {state.loaded && state.items.length === 0 && <p>No saved memory proposals to review. Background reviews can leave proposals here. Conversation additions are reviewed in Ask.</p>}
      {state.held > 0 && <p className="text-hold">{state.held} {state.held === 1 ? 'review needs' : 'reviews need'} attention. Existing memory and recovery records are preserved.</p>}
      {!!state.items.length && <div aria-label="Saved memory reviews" className="divide-y divide-line border-y border-line">{state.items.map(item => <button key={item.id} type="button" className={`flex min-h-14 w-full flex-wrap items-start justify-between gap-2 px-2 py-3 text-left focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50 ${selected?.id === item.id ? 'bg-selected' : ''}`} disabled={blocked} aria-pressed={selected?.id === item.id} onClick={() => void session.select(item.id)}><span><span className="block font-medium">{item.target ? targets[item.target] : 'Memory proposal'}{item.action ? ` · ${actions[item.action]}` : ''}</span><span className="block text-xs text-ink-muted">{item.origin ? origins[item.origin] : 'Details unavailable'}{item.createdAt !== null ? ` · ${new Date(item.createdAt).toLocaleString()}` : ''}</span></span><span className="text-xs">{selected?.id === item.id && state.needsCheck ? 'Decision needs confirmation' : states[item.state]}</span></button>)}</div>}
      {state.cursor && <button type="button" className={button} disabled={blocked} onClick={() => void session.refresh(true)}>Show more reviews</button>}
      {selected && <section aria-label="Selected memory review" className="min-w-0 space-y-3 border-t border-line pt-4">
        <div><h4 className="font-medium">{selected.target ? targets[selected.target] : 'Memory proposal'} · {state.needsCheck ? 'Decision needs confirmation' : states[selected.state]}</h4>{selected.origin && <p className="text-ink-muted">{origins[selected.origin]}</p>}</div>
        {state.needsCheck ? <><p>{state.missing ? 'This review is no longer listed. Refresh saved reviews before continuing.' : 'The decision is not yet confirmed. Check its saved state before continuing.'}</p><button type="button" className={button} disabled={blocked} onClick={() => void session.refresh()}>Check saved decision</button></>
          : selected.state === 'recovery-required' ? <><p>A saved decision needs to finish. Resuming checks and completes only that recorded decision; it does not approve a different change.</p>{selected.decision && selected.reviewDigest ? <button type="button" className={button} disabled={blocked} onClick={() => void session.decide(selected.decision!, true)}>Resume saved {selected.decision === 'approve' ? 'approval' : 'rejection'}</button> : <p>Contact your RealBud administrator to review recovery. No new decision is available here.</p>}</>
          : selected.state === 'unavailable' ? <p>These files need service review. Check Bud setup or contact your RealBud administrator. Existing files are preserved.</p>
          : selected.state === 'applied' ? <p>This memory decision is saved. Start a new conversation to use the updated preferences.</p>
          : selected.state === 'rejected' ? <p>This proposal was rejected. It cannot be approved from this review.</p>
          : !preview && busy !== 'preview' && <button type="button" className={button} disabled={blocked} onClick={() => void session.select(selected.id)}>Review complete change</button>}
        {busy === 'preview' && <p role="status">Loading the complete change…</p>}
        {preview && !state.missing && <>
          <p>{actions[preview.action]} · {preview.operationCount} {preview.operationCount === 1 ? 'operation' : 'operations'} · saved memory limit {preview.charLimit.toLocaleString()} characters</p>
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2"><MemoryReviewText label="Before — currently saved" value={preview.before} /><MemoryReviewText label="After — proposed complete text" value={preview.after} /></div>
          <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1 size-4 shrink-0" disabled={blocked} checked={state.confirmed} onChange={event => session.confirm(event.target.checked)} /><span>I reviewed the complete before and after text and approve this exact version once.</span></label>
          <div className="flex flex-wrap gap-2"><button type="button" className={cn(button, 'border-agency bg-agency text-white')} disabled={blocked || !state.confirmed} onClick={() => void session.decide('approve')}>Apply reviewed change</button><button type="button" className={button} disabled={blocked} onClick={() => void session.decide('reject')}>Reject this proposal</button></div>
          <p className="text-xs text-ink-muted">This decision applies only to the displayed proposal. It does not create an ongoing approval.</p>
        </>}
      </section>}
      {state.error && <p role="alert" className="text-danger">{state.error}</p>}
      <p role="status" aria-live="polite" className="text-ink-secondary">{busy === 'list' ? 'Checking saved reviews…' : busy === 'decision' ? 'Saving your decision and checking its result…' : state.notice}</p>
      <MemoryRecoveryPanel coordinator={coordinator} />
    </div>
  </Card></section>;
}
